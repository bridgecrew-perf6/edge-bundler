import { promises as fs } from 'fs'
import path from 'path'
import process from 'process'

import { execa } from 'execa'
import semver from 'semver'
import { tmpName } from 'tmp-promise'

import { bundle } from './bundler.js'
import type { Declaration } from './declaration.js'
import { download } from './downloader.js'
import { getPathInHome } from './home_path.js'
import { generateManifest } from './manifest.js'
import { getBinaryExtension } from './platform.js'

const DENO_VERSION_FILE = 'version.txt'
const DENO_VERSION_RANGE = '^1.17.2'

type LifecycleHook = () => void | Promise<void>

interface DenoOptions {
  cacheDirectory?: string
  onAfterDownload?: LifecycleHook
  onBeforeDownload?: LifecycleHook
  useGlobal?: boolean
  versionRange?: string
}

class DenoBridge {
  cacheDirectory: string
  onAfterDownload?: LifecycleHook
  onBeforeDownload?: LifecycleHook
  useGlobal: boolean
  versionRange: string

  constructor(options: DenoOptions = {}) {
    this.cacheDirectory = options.cacheDirectory ?? getPathInHome('deno-cli')
    this.onAfterDownload = options.onAfterDownload
    this.onBeforeDownload = options.onBeforeDownload
    this.useGlobal = options.useGlobal ?? true
    this.versionRange = options.versionRange ?? DENO_VERSION_RANGE
  }

  static async getBinaryVersion(binaryPath: string) {
    try {
      const { stdout } = await execa(binaryPath, ['--version'])
      const version = stdout.match(/^deno ([\d.]+)/)

      if (!version) {
        return
      }

      return version[1]
    } catch {
      // no-op
    }
  }

  private async getCachedBinary() {
    const versionFilePath = path.join(this.cacheDirectory, DENO_VERSION_FILE)

    let cachedVersion

    try {
      cachedVersion = await fs.readFile(versionFilePath, 'utf8')
    } catch {
      return
    }

    if (!semver.satisfies(cachedVersion, this.versionRange)) {
      return
    }

    const binaryName = `deno${getBinaryExtension()}`

    return path.join(this.cacheDirectory, binaryName)
  }

  private async getGlobalBinary() {
    if (!this.useGlobal) {
      return
    }

    const globalBinaryName = 'deno'
    const globalVersion = await DenoBridge.getBinaryVersion(globalBinaryName)

    if (globalVersion === undefined || !semver.satisfies(globalVersion, this.versionRange)) {
      return
    }

    return globalBinaryName
  }

  private async getRemoteBinary() {
    if (this.onBeforeDownload) {
      this.onBeforeDownload()
    }

    await fs.mkdir(this.cacheDirectory, { recursive: true })

    const binaryPath = await download(this.cacheDirectory)
    const version = await DenoBridge.getBinaryVersion(binaryPath)

    if (version === undefined) {
      throw new Error('Could not read downloaded binary')
    }

    await this.writeVersionFile(version)

    if (this.onAfterDownload) {
      this.onAfterDownload()
    }

    return binaryPath
  }

  private async writeVersionFile(version: string) {
    const versionFilePath = path.join(this.cacheDirectory, DENO_VERSION_FILE)

    await fs.writeFile(versionFilePath, version)
  }

  async bundle(sourceDirectories: string[], distDirectory: string, declarations: Declaration[]) {
    const { bundlePath, handlers, preBundlePath } = await bundle(sourceDirectories, distDirectory)
    const relativeBundlePath = path.relative(distDirectory, bundlePath)
    const manifestContents = generateManifest(relativeBundlePath, handlers, declarations)
    const manifestPath = path.join(distDirectory, 'manifest.json')

    await fs.writeFile(manifestPath, JSON.stringify(manifestContents))

    await this.run(['bundle', preBundlePath, bundlePath])
    await fs.unlink(preBundlePath)

    return { bundlePath, manifestPath, preBundlePath }
  }

  async getBinaryPath(): Promise<string> {
    const globalPath = await this.getGlobalBinary()

    if (globalPath !== undefined) {
      return globalPath
    }

    const cachedPath = await this.getCachedBinary()

    if (cachedPath !== undefined) {
      return cachedPath
    }

    return this.getRemoteBinary()
  }

  async run(args: string[], { wait = true }: { wait?: boolean } = {}) {
    const binaryPath = await this.getBinaryPath()
    const runDeno = execa(binaryPath, args)

    runDeno.stderr?.pipe(process.stdout)

    if (!wait) {
      return runDeno
    }

    await runDeno
  }

  async serve(port: number, sourceDirectories: string[], declarations: Declaration[]) {
    const distDirectory = await tmpName()
    const { preBundlePath } = await bundle(sourceDirectories, distDirectory)

    return this.run(['run', '-A', '--unstable', preBundlePath, port.toString()], { wait: false })
  }
}

export { DenoBridge }
