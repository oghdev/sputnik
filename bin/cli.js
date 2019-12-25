require('dotenv').config()

const yargs = require('yargs')
const logger = require('../lib/logger')

const Sputnik = require('../index')

const build = async (argv) => {

  logger.level = argv.logLevel || process.env.LOG_LEVEL || 'info'

  const cwd = argv.cwd
  const webpackConfig = argv.webpackConfig
  const force = argv.force
  const failFast = argv.failFast

  const sputnik = new Sputnik({ cwd, webpackConfig, force, failFast })

  sputnik.on('builds', ({ builds }) => {

    logger.info(`Found ${builds.length} build targets`)

  })

  sputnik.on('build.dependencies', ({ build, dependencies, file }) => {

    logger.debug(`Found ${dependencies.length} dependencies for file ${file}`)

  })

  sputnik.on('lint.file.error', ({ build, file, errors }) => {

    for (const error of errors) {

      if (error) {

        logger.error(`Lint error on file ${file} at line ${error.line}:${error.column}. error=${error.message}`)

      }

    }

  })

  sputnik.on('lint.file', ({ build, file }) => {

    logger.debug(`File ${file} linted with no errors`)

  })

  sputnik.on('lint.error', ({ errors }) => {

    logger.error(`Linter finished with ${errors.length} errors`)

  })

  sputnik.on('lint', ({ file, dependencies }) => {

    logger.verbose(`Linter for ${file} finished on ${dependencies.length} dependencies`)

  })

  sputnik.on('diff.file', ({ build, file, changed, currentHash, previousHash }) => {

    logger.debug(`Diff computed on file ${file}. changed=${changed} currentHash=${currentHash} previousHash=${previousHash}`)

  })

  sputnik.on('diff.error', ({ build, file, errors }) => {

    for (const error of errors) {

      logger.error(`Diff error on file ${file}. error=${error.message}`)

    }

  })

  sputnik.on('build', ({ build, file, hash, stats }) => {

    const duration = (stats.endTime - stats.startTime)

    logger.info(`Build for ${file} completed in ${duration}ms. hash=${hash} webpackHash=${stats.hash}`)

  })

  sputnik.on('build.error', ({ build, file, errors }) => {

    for (const error of errors) {

      logger.error(`Build error on file ${file}. error=${error.message}`)

    }

  })

  sputnik.on('build.ready', ({ build, file }) => {

    logger.info(`Build for ${file} ready`)

  })

  sputnik.on('build.skip', ({ file }) => {

    logger.info(`Build skipped for ${file}`)

  })

  sputnik.on('build.stats', ({ files, built, skipped }) => {

    if (built.length > 0) {

      logger.info(`Builds completed for ${built.length} of ${files.length} files`)

    }

    if (skipped.length > 0) {

      logger.warn(`Skipped ${skipped.length} of ${files.length} files`)

    }

  })

  logger.info(`Starting build`)

  const res = await sputnik.build()

  if (res) {

    logger.info('Builds complete')

    process.exit(0)

  } else {

    logger.error('Build failed')

    process.exit(1)

  }

}

const deploy = async (argv) => {

  logger.level = argv.logLevel || process.env.LOG_LEVEL || 'info'

  const cwd = argv.cwd
  const dockerAuth = argv.dockerAuth
  const registry = argv.registry
  const force = argv.force
  const failFast = argv.failFast

  if (argv.insecureRegistry) {

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0

  }

  const sputnik = new Sputnik({ cwd, dockerAuth, registry, force, failFast })

  sputnik.on('deployments', ({ deployments }) => {

    logger.info(`Found ${deployments.length} deployment targets`)

  })

  sputnik.on('diff.dependency', ({ deployment, dependency, changed, currentHash, previousHash }) => {

    logger.debug(`Diff computed on dependency ${dependency}. changed=${changed} currentHash=${currentHash} previousHash=${previousHash}`)

  })

  sputnik.on('dependency.error', ({ deployment, file, errors }) => {

    for (const error of errors) {

      logger.error(`Diff error on file ${file}. error=${error.message}`)

    }

  })

  sputnik.on('deployment.dependencies', ({ deployment, dependencies, file }) => {

    logger.debug(`Found ${dependencies.length} dependencies for file ${file}`)

  })

  sputnik.on('deployment.image.tag', ({ file, tag }) => {

    logger.verbose(`Got image tag for ${file} image build. tag=${tag}`)

  })

  sputnik.on('deployment.image.exists', ({ file, tag }) => {

    logger.verbose(`Found existing image for ${file}. tag=${tag}`)

  })

  sputnik.on('deployment.image.build', ({ file, stdout }) => {

    const res = stdout.toString().trim()

    if (res === '') {

      return

    }

    logger.debug(`Building image for ${file}: ${res}`)

  })

  sputnik.on('deployment.image.build.complete', ({ file, hash }) => {

    logger.debug(`Completed image build for ${file}. hash=${hash}`)

  })

  sputnik.on('deployment.image.push', ({ file, tag, layer, progress }) => {

    logger.debug(`Pushing image layer for ${file}. tag=${tag} layer=${layer} progress=${progress}`)

  })

  sputnik.on('deployment.image.pushed', ({ file, layer }) => {

    logger.debug(`Completed image layer push for ${file}. layer=${layer}`)

  })

  sputnik.on('deployment.skip', ({ file }) => {

    logger.info(`Deployment skipped for ${file}`)

  })

  sputnik.on('deployment.output', ({ stdout }) => {

    logger.info(stdout.trim())

  })

  sputnik.on('deployment.error', ({ deployment, file, errors }) => {

    for (const error of errors) {

      logger.error(`Deployment error${file ? ` on file ${file}` : ''}. error=${error.message}`)

    }

  })

  sputnik.on('deployment.ready', ({ deployment, file }) => {

    logger.info(`Deployment for ${file} ready`)

  })

  sputnik.on('deployment.manifest', ({ manifest }) => {

    logger.info(`Applying kube manifest:\n ${manifest}`)

  })

  sputnik.on('deployment.stats', ({ files, deployed, skipped }) => {

    if (deployed.length > 0) {

      logger.info(`Deployments completed for ${deployed.length} of ${files.length} files`)

    }

    if (skipped.length > 0) {

      logger.warn(`Skipped ${skipped.length} of ${files.length} files`)

    }

  })

  logger.info(`Starting deployment`)

  const res = await sputnik.deploy()

  if (res) {

    logger.info('Deployments complete')

    process.exit(0)

  } else {

    logger.error('Deployment failed')

    process.exit(1)

  }

}

yargs
  .scriptName('sputnik')
  .command(
    'build',
    'Start a build',
    (yargs) => (
      yargs.option('webpack-config', {
        type: 'string',
        description: 'Path to webpack config file to be used for build (e.g --webpack-config webpack.config.js)'
      })
      .option('cwd', {
        type: 'string',
        description: 'Path to the working directory. Defaults to the cwd'
      })
      .option('fail-fast', {
        type: 'boolean',
        description: 'Exits immediatley on first error for a file'
      })
      .option('force', {
        type: 'boolean',
        description: 'Skips any git diff checks and builds all packages'
      })
      .option('log-level', {
        type: 'string',
        choices: [ 'info', 'warn', 'debug', 'trace', 'error' ]
      })
    ),
    build
  )
  .command(
    'deploy',
    'Start a deployment',
    (yargs) => (
      yargs.option('registry', {
        type: 'string',
        description: 'Registry to deploy images to. Defaults to docker.io (e.g. --registry my.registry.local:5000)'
      })
      .option('insecure-registry', {
        type: 'boolean',
        description: 'Allow connection to an insecure registry'
      })
      .option('docker-auth', {
        type: 'array',
        description: 'Provide docker credentials for private registies (e.g --docker-auth username:password --docker-auth my.registry.local:5000:username:password)'
      })
      .option('cwd', {
        type: 'string',
        description: 'Path to the working directory. Defaults to the cwd'
      })
      .option('fail-fast', {
        type: 'boolean',
        description: 'Exits immediatley on first error for a file'
      })
      .option('force', {
        type: 'boolean',
        description: 'Skips any git diff checks and deploy all packages'
      })
      .option('log-level', {
        type: 'string',
        choices: [ 'info', 'warn', 'debug', 'trace', 'error' ]
      })
    ),
    deploy
  )
  .group([ 'help', 'version' ], 'Global Options:')
  .strict()
  .help()
  .version()
  .showHelpOnFail(true, 'Specify --help for available options')
  .wrap(yargs.terminalWidth()*0.75)
  .argv
