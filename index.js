const EventEmitter = require("events")
const CLIEngine = require("eslint").CLIEngine
const Docker = require('dockerode')

const simpleGit = require('simple-git/promise')
const glob = require("glob")
const path = require('path')
const fs = require('fs')
const madge = require('madge')
const webpack = require('webpack')
const util = require('util')
const merge = require('merge-deep')
const sha256 = require('hash.js/lib/hash/sha/256')
const findInFile = util.promisify(require('find-in-file'))
const shortid = require('shortid32')
const tar = require('tar-stream')
const tmp = require('tmp-promise')
const shell = require('shelljs')
const os = require('os')

class Sputnik extends EventEmitter {

  constructor (config) {

    super()

    config = config || {}

    Object.keys(config).forEach(key => config[key] === undefined && delete config[key])

    this.config = Object.assign({
      cwd: process.cwd(),
      failFast: false,
      force: false
    }, config)

  }

  async build () {

    const git = simpleGit(this.config.cwd)

    const failFast = this.config.failFast

    const builds = glob.sync('build/**/main.js', { cwd: this.config.cwd, absolute: true })

    const skipped = []
    const built = []

    this.emit('builds', { builds })

    for (const build of builds) {

      const buildDir = path.dirname(build)
      const buildName = build.replace(this.config.cwd, '')
        .replace('/build/', '')
        .replace('/main.js', '')
        .replace(/\//g, '-')
      const file = path.resolve(buildDir, build).replace(`${this.config.cwd}/`, '')

      const source = fs.readFileSync(build).toString()

      const webpackrc = path.resolve(this.config.cwd, this.config.webpackConfig)

      const depTree = await madge(build, { webpackConfig: webpackrc }).then((res) => res ? res.obj() : {})
      const dependencies = Object.keys(depTree)
        .filter((d) => d.endsWith('.js'))
        .map((d) => path.resolve(buildDir, d).replace(`${this.config.cwd}/`, ''))

      this.emit('build.dependencies', { build, dependencies, file })

      const eslintrc = `${this.config.cwd}/.eslintrc.json`
      const eslintConfig = fs.readFileSync(eslintrc).toString()

      const linterErrors = []

      const linter = new CLIEngine(eslintConfig)

      for (const target of dependencies) {

        const report = linter.executeOnText(fs.readFileSync(target).toString(), target)

        if (report.errorCount && report.errorCount > 0) {

          const [ result ] = report.results

          const messages = result.messages
          const errors = messages.filter((r) => r.severity === 2)

          errors.map((err) => linterErrors.push(Object.assign(err, { file: target })))

          this.emit('lint.file.error', { build, file: target, errors })

          if (this.config.failFast) {

            return false

          }

        }

        this.emit('lint.file', { build, file: target, report, source })

      }

      if (linterErrors.length > 0) {

        const errors = linterErrors

        this.emit('lint.error', { build, errors })

        return false

      }

      this.emit('lint', { file, dependencies })

      const outputDir = buildDir.replace('build/', 'dist/')

      const dependencyHash = sha256().update(JSON.stringify(dependencies.map((d) => {

        return sha256().update(fs.readFileSync(d)).digest('hex').substr(0, 10)

      }))).digest('hex').substr(0, 10)

      if (!this.config.force) {

        const [ head, lastCommit ] = await git.silent(true).log().then((log) => log.all)

        let needsbuild

        if (!head || !lastCommit) {

          needsbuild = true

        } else {

          for (const file of dependencies) {

            try {

              const [
                current,
                previous
              ] = await Promise.all([
                git.silent(true).show([`${head.hash}:${file}`]),
                git.silent(true).show([`${lastCommit.hash}:${file}`])
              ])

              const [
                currentHash,
                previousHash
              ] = [
                sha256().update(current).digest('hex'),
                sha256().update(previous).digest('hex')
              ]

              const changed = currentHash !== previousHash

              this.emit('diff.file', { build, file, changed, currentHash, previousHash })

              if (changed) {

                needsbuild = true

              }

            } catch (err) {

              const errors = [ err ]

              this.emit('diff.error', { errors })

              needsbuild = true

            }

          }

        }

        try {

          const currentDepHash = fs.readFileSync(path.resolve(outputDir, `deps.sha256`)).toString()

          if (currentDepHash === dependencyHash) {

            needsbuild = false

          }

        } catch (err) {

          if (err.code !== 'ENOENT') throw err

        }

        if (!needsbuild) {

          this.emit('build.skip', { build, file })

          skipped.push(build)

          continue

        } else {

          this.emit('build.ready', { build, buildName })

        }

      }

      const webpackConfig = merge(require(webpackrc), {
        output: {
          path: outputDir,
          filename: 'main.js'
        },
        entry: build
      })

      const compiler = webpack(webpackConfig)

      const webpackRun = util.promisify(compiler.run.bind(compiler))

      const stats = await webpackRun()

      if (stats.compilation.errors && stats.compilation.errors.length > 0) {

        const errors = stats.compilation.errors

        this.emit('build.error', { build, file, errors })

        return false

      }

      const hash = sha256().update(fs.readFileSync(`${outputDir}/main.js`)).digest('hex').substr(0, 10)

      fs.writeFileSync(path.resolve(outputDir, `deps.sha256`), dependencyHash)
      fs.writeFileSync(path.resolve(outputDir, 'package.json'), JSON.stringify({ name: buildName, version: hash, deps: dependencyHash }))

      this.emit('build', { build, buildName, file, dependencyHash, hash, stats })

      built.push(build)

    }

    this.emit('build.stats', { files: builds, built, skipped })

    return true

  }

  async deploy () {

    const self = this

    const git = simpleGit(this.config.cwd)

    const dockerAuth = this.config.dockerAuth
    const registry = this.config.registry
    const failFast = this.config.failFast

    const deployments = glob.sync('dist/**/main.js', { cwd: this.config.cwd, absolute: true })
    const tags = {}

    const skipped = []
    const deployed = []

    this.emit('deployments', { deployments })

    const docker = new Docker()
    const credentials = (dockerAuth || []).reduce((acc, val) => {

      let [
        registry,
        username,
        password
      ] = val.split(':')

      if (!password) {

        password = username
        username = registry
        registry = 'docker.io'

      }

      return Object.assign({}, acc, { [registry] : { username, password }})

    }, {})

    const yamlDeployFiles = glob.sync('deploy/**/*.yaml', { cwd: this.config.cwd, absolute: true })
    const deployFiles = []

    for (const deployment of deployments) {

      let needsdeploy

      const deploymentDir = path.dirname(deployment)
      const manifest = require(`${deploymentDir}/package.json`)

      const deploymentName = manifest.name
      const deploymentVersion = manifest.version

      const file = path.resolve(deploymentDir, deployment).replace(`${this.config.cwd}/`, '')

      const [ index, ...parts ] = registry.split('/')

      const repo = parts.join('/')
      const auth = credentials[index]

      if (!auth) {

        throw new Error(`Invalid registry auth for ${index}`)

      }

      const authconfig = {
        username: auth.username,
        password: auth.password,
        serveraddress: index
      }

      const tag = `${index}/${repo}/${deploymentName}:${deploymentVersion}`

      this.emit('deployment.image.tag', { deployment, file, tag })

      tags[deployment] = tag

      const login = await docker.checkAuth(authconfig)

      try {

        const pull = await docker.pull(tag, { authconfig })

        if (pull) {

          pull.close && pull.close()

        }

        this.emit('deployment.image.exists', { deployment, file, tag })

      } catch (err) {

        if (err.statusCode && err.statusCode === 404) {

          needsdeploy = true

          const dockerfile = `

FROM node:12-alpine

ENV APP_NAME="${deploymentName}"
ENV APP_VERSION="${deploymentVersion}"

COPY main.js /usr/src/app/main.js

CMD ["node", "/usr/src/app/main.js"]

          `.trim()

          const pack = tar.pack()

          await pack.entry({ name: 'Dockerfile' }, dockerfile)
          await pack.entry({ name: 'main.js' }, fs.readFileSync(deployment))

          await pack.finalize()

          try {

            const stream = await docker.buildImage(pack, { t: tag })

            await (new Promise((resolve, reject) => {

              const progress = ({ stream, aux }) => {

                if (stream) {

                  this.emit('deployment.image.build', { deployment, file, stdout: stream })

                }

                if (aux) {

                  const hash = aux.ID

                  this.emit('deployment.image.build.complete', { deployment, file, hash })

                }

              }

              docker.modem.followProgress(stream, resolve, progress)

              stream.on('error', reject)

            }))

          } finally {}

          try {

            const image = await docker.getImage(tag)
            const stream = await image.push({ registry, authconfig })

            await (new Promise((resolve, reject) => {

              const progress = (e) => {

                const { id, status, progressDetail } = e

                if (status && (status.toLowerCase() === 'pushed' || status.toLowerCase() === 'layer already exists')) {

                  const layer = id

                  this.emit('deployment.image.pushed', { deployment, file, tag, layer })

                } else if (status && status.toLowerCase() === 'pushing') {

                  const layer = id

                  const progress = progressDetail.current
                    ? Math.floor((progressDetail.current / progressDetail.current) * 100)
                    : 0

                  this.emit('deployment.image.push', { deployment, file, tag, layer, progress })

                }

              }

              docker.modem.followProgress(stream, resolve, progress)

              stream.on('error', reject)

            }))

          } finally {}

        } else {

          const errors = [ err ]

          this.emit('deployment.error', { deployment, file, errors })

          if (this.config.failFast) {

            return false

          }

        }

      }

      const dir = path.dirname(file)

      const dependencies = await findInFile({ files: yamlDeployFiles, find: dir })
        .then((res) => res.map((r) => path.resolve(deploymentDir, r.file).replace(`${this.config.cwd}/`, '')))

      this.emit('deployment.dependencies', { deployment, dependencies, file })

      if (needsdeploy || this.config.force) {

        dependencies.map((d) => deployFiles.indexOf(d) === -1 && deployFiles.push(d))

        deployed.push(deployment)

        this.emit('deployment.ready', { deployment, file })

      } else {

        this.emit('deployment.skip', { deployment, file })

        skipped.push(deployment)

      }

    }

    const [ head, lastCommit ] = await git.silent(true).log().then((log) => log.all)

    for (const dependency of yamlDeployFiles.map((y) => y.replace(`${this.config.cwd}/`, ''))) {

      try {

        const [
          current,
          previous
        ] = await Promise.all([
          git.silent(true).show([`${head.hash}:${dependency}`]),
          git.silent(true).show([`${lastCommit.hash}:${dependency}`])
        ])

        const [
          currentHash,
          previousHash
        ] = [
          sha256().update(current).digest('hex'),
          sha256().update(previous).digest('hex')
        ]

        const changed = currentHash !== previousHash

        this.emit('diff.dependency', { dependency, changed, currentHash, previousHash })

        if (changed || this.config.force) {

          deployFiles.indexOf(dependency) === -1 && deployFiles.push(dependency)

        }

      } catch (err) {

        const errors = [ err ]

        this.emit('diff.error', { errors })

      }

    }

    if (deployFiles.length > 0) {

      let kubeyaml = deployFiles.reduce((acc, val) => {

        return `${acc}
---
${fs.readFileSync(val)}`

      }, '')

      for (const deployment of deployments) {

        const tag = tags[deployment]

        const find = path.dirname(deployment).replace(`${this.config.cwd}/`, '')
        const replace = tag

        kubeyaml = kubeyaml.replace(find, replace)

      }

      kubeyaml = kubeyaml.replace(new RegExp(`---${os.EOL}---`, 'g'), '---')

      const tmpFile = await tmp.file()

      fs.writeFileSync(tmpFile.path, kubeyaml)

      this.emit('deployment.manifest', { manifest: kubeyaml })

      try {

        const res = await shell.exec(`kubectl apply -f ${tmpFile.path}`, { silent: true })

        if (res.stderr) {

          throw new Error(res.stderr.toString().trim())

        }

        res.stdout.toString().trim()
          .split(os.EOL)
          .map((r) => r.trim())
          .map((stdout) => {

            self.emit('deployment.output', { stdout })

          })

        await tmpFile.cleanup()

      } catch (err) {

        const errors = [ err ]

        this.emit('deployment.error', { errors })

        return false

      }

    }

    this.emit('deployment.stats', { files: deployments, deployed, skipped })

    return true

  }

}

module.exports = Sputnik
