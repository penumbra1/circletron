#!/usr/bin/env node

import { exec } from 'child_process'
import { readFile } from 'fs-extra'
import { promisify } from 'util'
import axios from 'axios'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { join as pathJoin } from 'path'

const CONTINUATION_API_URL = `https://circleci.com/api/v2/pipeline/continue`

const pExec = promisify(exec)

const requireEnv = (varName: string): string => {
  const value = process.env[varName]
  if (!value) {
    throw new Error(`Environment variable ${varName} must be set`)
  }
  return value
}

interface Package {
  name: string
  circleConfig: string
}

interface CircleLernaConfig {
  dependencies: Record<string, string[]>
}

async function getPackages(): Promise<Package[]> {
  const packageOutput = await pExec(`lerna list --parseable --all --long`)
  const allPackages = await Promise.all(
    packageOutput.stdout
      .trim()
      .split('\n')
      .map(async (line) => {
        const [fullPath, name] = line.split(':')
        let circleConfig = ''
        try {
          circleConfig = (await readFile(pathJoin(fullPath, 'circle.yml'))).toString()
        } catch (e) {
          // no circle config, filter below
        }

        return { circleConfig, name }
      }),
  )
  return allPackages.filter((pkg) => pkg.circleConfig !== '')
}

/**
 * Get the names of the packages which builds should be triggered for by
 * determing which packages have changed in this branch and consulting
 * .circleci/lerna.yml to packages that should be run due to a dependency
 * changing.
 */
const getTriggerPackages = async (
  packages: Package[],
  config: CircleLernaConfig,
  branch: string,
): Promise<Set<string>> => {
  // run all jobs when the source is the release/develop branches directly
  const runAll = branch === 'develop' || branch.startsWith('release/')
  const changedPackages = new Set<string>()

  if (runAll) {
    console.log(`Detected a push from ${branch}, running all pipelines`)
  } else {
    const parentBranchOutput = await pExec('get-branchpoint-commit.sh')
    // have to prepend origin, when `develop` is used directly, circle incorrectly thinks
    // `develop` points to the tip of the current branch. they are doing something weird
    // with their git checkout I guess.
    const branchpointCommit = parentBranchOutput.stdout.trim()

    console.log("Looking for changes since `%s'", branchpointCommit)
    const changeOutput = await pExec(
      `lerna list --parseable --all --long --since ${branchpointCommit}`,
    )

    const changesStr = changeOutput.stdout.trim()

    if (!changesStr) {
      console.log('Found no changed packages')
    } else {
      for (const pkg of changesStr.split('\n')) {
        changedPackages.add(pkg.split(':', 2)[1])
      }

      console.log('Found changes: %O', changedPackages)
    }
  }

  const allPackageNames = new Set(packages.map((pkg) => pkg.name))
  if (runAll) {
    return allPackageNames
  }

  return new Set(
    Array.from(changedPackages)
      .flatMap((changedPackage) => [
        changedPackage,
        ...Object.entries(config.dependencies)
          .filter(([, deps]) => deps.includes(changedPackage))
          .map(([pkgName]) => pkgName),
      ])
      .filter((pkg) => allPackageNames.has(pkg)),
  )
}

const SKIP_JOB = {
  docker: [{ image: 'busybox:stable' }],
  steps: [
    {
      run: {
        name: 'Jobs not required',
        command: 'echo "Jobs not required"',
      },
    },
  ],
}

async function buildConfiguration(
  packages: Package[],
  triggerPackages: Set<string>,
): Promise<string> {
  const config = yamlParse((await readFile('circle.yml')).toString())

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mergeObject = (path: string, projectYaml: any): void => {
    for (const [name, value] of Object.entries(projectYaml[path] ?? {})) {
      if (config[path][name]) {
        throw new Error(`Two ${path} with the same name: ${name}`)
      }
      config[path][name] = value
    }
  }
  const jobsConfig = config.jobs

  for (const pkg of packages) {
    const projectYaml = yamlParse(pkg.circleConfig)

    mergeObject('workflows', projectYaml)
    mergeObject('orbs', projectYaml)
    mergeObject('executors', projectYaml)
    mergeObject('commands', projectYaml)

    const jobs = projectYaml.jobs as Record<string, { conditional?: boolean }>
    for (const [jobName, jobData] of Object.entries(jobs)) {
      if (jobsConfig[jobName]) {
        throw new Error(`Two jobs with the same name: ${jobName}`)
      }
      if ('conditional' in jobData) {
        const { conditional } = jobData
        delete jobData.conditional
        if (conditional === false) {
          // these jobs are triggered no matter what
          jobsConfig[jobName] = jobData
          continue
        }
      }
      jobsConfig[jobName] = triggerPackages.has(pkg.name) ? jobData : SKIP_JOB
    }
  }
  return yamlStringify(config)
}

export async function getCircleLernaConfig(): Promise<CircleLernaConfig> {
  let rawConfig: { dependencies?: CircleLernaConfig['dependencies'] } = {}
  try {
    rawConfig = yamlParse((await readFile(pathJoin('.circleci', 'lerna.yml'))).toString())
  } catch (e) {
    // lerna.yml is not mandatory
  }

  return { dependencies: rawConfig.dependencies ?? {} }
}

export async function triggerCiJobs(branch: string, continuationKey: string): Promise<void> {
  const lernaConfig = await getCircleLernaConfig()
  const packages = await getPackages()
  const triggerPackages = await getTriggerPackages(packages, lernaConfig, branch)

  const body = {
    'continuation-key': continuationKey,
    configuration: await buildConfiguration(packages, triggerPackages),
  }
  console.log('CircleCI request to %s: %O', CONTINUATION_API_URL, body)

  const response = await axios.post(CONTINUATION_API_URL, body)
  console.log('CircleCI response: %O', response.data)
}

if (require.main === module) {
  const branch = requireEnv('CIRCLE_BRANCH')
  const continuationKey = requireEnv('CIRCLE_CONTINUATION_KEY')

  triggerCiJobs(branch, continuationKey).catch((err) => {
    console.warn('Got error: %O', err)
    process.exit(1)
  })
}
