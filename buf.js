#!/usr/bin/env node

// Automatically installs buf if not found on $PATH, then
// runs it transiently.

const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { findBufVersionConfig, listInstalled, makeReleaseName, httpGetRedirect, httpDownload, mkDirRecursive, findBufInPath, standardInstallDirectory } = require('./util')

main().catch(err => {
  console.error((err instanceof Error) ? err.message : err)
  process.exit(1)
})

async function main () {
  // The full path to the buf executable.
  let command

  // Does the nearest package.json have a config.bufVersion?
  const configuredVersion = findBufVersionConfig(process.cwd())

  if (configuredVersion) {
    // We prefer the configured buf version and install it.
    const release = await ensureInstalled(configuredVersion)
    command = release.bufPath
  } else {
    // There is no configured buf version. Do we have buf in the $PATH?
    command = findBufInPath(process.env.PATH)
    if (!command) {
      // No buf in $PATH, install the latest version.
      const release = await ensureInstalled(configuredVersion)
      command = release.bufPath
    }
  }

  // Add node_modules/.bin to the PATH.
  // This will allow using protoc and plugins installed through NPM.
  const nodeModulesBin = getNodeModulesBinPath()
  if (nodeModulesBin) {
    process.env.PATH = `${nodeModulesBin}:${process.env.PATH}`
  }

  const args = [
    // Pass all arguments to the process
    ...process.argv.slice(2)
  ]

  const child = spawnSync(command, args, {
    // Buf accepts stdin for some commands, pipe all IO
    stdio: [process.stdin, process.stdout, process.stderr],
    shell: false
  })

  if (child.error) {
    throw new Error('bufbuild was unable to spawn buf. ' + child.error)
  }
  process.exit(child.status)
}

async function ensureInstalled (version) {
  // Resolve the latest release version number if necessary
  if (version === 'latest' || version === undefined) {
    let latestLocation
    try {
      latestLocation = await httpGetRedirect('https://github.com/bufbuild/buf/releases/latest')
    } catch (e) {
      throw new Error(`bufbuild failed to retrieve latest buf version number: ${e}`)
    }
    version = latestLocation.split('/v').pop()
  }

  // Make the release name for the current platform and the requested version number
  // e.g. '1.6.0/buf-Darwin-arm64'
  const releaseName = makeReleaseName({
    platform: os.platform(),
    arch: os.arch(),
    version
  })

  // If this release is already installed, we are done here
  const alreadyInstalled = listInstalled().find(i => i.name === releaseName)
  if (alreadyInstalled) {
    return alreadyInstalled
  }

  // Download the release
  let binaryContent
  try {
    binaryContent = await httpDownload(`https://github.com/bufbuild/buf/releases/download/v${releaseName}`)
  } catch (e) {
    throw new Error(`bufbuild failed to download buf v${version}. \nDid you misspell the version number? The version number must look like "1.6.0", without a leading "v".\n${e}`)
  }
  // Save the release
  const releasePath = path.join(standardInstallDirectory, releaseName)
  const releaseDir = path.dirname(releasePath)
  mkDirRecursive(releaseDir)
  fs.writeFileSync(releasePath, binaryContent, { mode: 0o755 })

  // Sanity check
  const installed = listInstalled().find(i => i.name === releaseName)
  if (!installed) {
    throw new Error(`bufbuild failed to install buf v${version}.`)
  }

  // Finished
  console.info(`bufbuild installed buf v${installed.version}.`)
  return installed
}

function getNodeModulesBinPath () {
  const bufDir = path.dirname(process.argv[1])
  if (bufDir.endsWith('node_modules/.bin')) {
    return bufDir
  }
  return undefined
}
