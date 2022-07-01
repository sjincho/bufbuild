const path = require('path')
const fs = require('fs')
const os = require('os')
const assert = require('assert')

const standardInstallDirectory = path.join(__dirname, 'installed')
module.exports.standardInstallDirectory = standardInstallDirectory

/**
 * Make directory, creating missing parent directories as well.
 * Equivalent to fs.mkdirSync(p, {recursive: true});
 * @param {string} dirname
 */
module.exports.mkDirRecursive = function mkDirRecursive (dirname) {
  if (!path.isAbsolute(dirname)) {
    dirname = path.join(process.cwd(), dirname)
  }
  dirname = path.normalize(dirname)
  const parts = dirname.split(path.sep)
  for (let i = 2; i <= parts.length; i++) {
    const p = parts.slice(0, i).join(path.sep)
    if (fs.existsSync(p)) {
      const i = fs.lstatSync(p)
      if (!i.isDirectory()) {
        throw new Error("cannot mkdir '" + dirname + "'. '" + p + "' is not a directory.")
      }
    } else {
      fs.mkdirSync(p)
    }
  }
}

/**
 * @typedef {Object} DistEntry
 * @property {string} name e.g. '1.6.0/buf-Darwin-arm64'
 * @property {string} version e.g. '1.6.0'
 * @property {string} bufPath e.g. '/path/to/1.6.0/buf-Darwin-arm64'
 */

/**
 * @param {string} installDir
 * @return {DistEntry[]}
 */
module.exports.listInstalled = function listInstalled (installDir = standardInstallDirectory) {
  if (!fs.existsSync(installDir)) {
    return []
  }
  const entries = []
  for (const version of fs.readdirSync(installDir)) {
    const abs = path.join(installDir, version)
    if (!fs.lstatSync(abs).isDirectory()) {
      continue
    }
    for (const binaryName of fs.readdirSync(abs)) {
      if (!binaryName.startsWith('buf-')) {
        continue
      }
      entries.push({
        name: `${version}/${binaryName}`,
        version,
        bufPath: path.join(abs, binaryName)
      })
    }
  }
  return entries
}

/**
 * Download url into path. Returns path.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
module.exports.httpDownload = function download (url) {
  assert(typeof url === 'string' && url.length > 0)
  assert(url.startsWith('https://') || url.startsWith('http://'))
  const chunks = []
  return new Promise((resolve, reject) => {
    httpGet(url, []).then(
      response => {
        response.setEncoding('binary')
        response.on('data', chunk => {
          chunks.push(Buffer.from(chunk, 'binary'))
        })
        response.on('end', () => {
          resolve(Buffer.concat(chunks))
        })
      },
      reason => reject(reason)
    )
  })
}

/**
 * @param {string} url
 * @return {Promise<string>}
 */
module.exports.httpGetRedirect = function httpGetRedirect (url) {
  assert(typeof url === 'string' && url.length > 0)
  assert(url.startsWith('https://') || url.startsWith('http://'))
  const client = url.startsWith('https') ? require('https') : require('http')
  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location
        assert(location && location.length > 0)
        resolve(location)
      } else if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`))
      } else {
        reject(new Error(`Did not get expected redirect for ${url}`))
      }
    })
    request.on('error', reject)
  })
}

/**
 * HTTP GET, follows up to 3 redirects
 * @param {string} url
 * @param {string[]} redirects
 * @returns {Promise<IncomingMessage>}
 */
function httpGet (url, redirects) {
  assert(typeof url === 'string' && url.length > 0)
  assert(url.startsWith('https://') || url.startsWith('http://'))
  assert(Array.isArray(redirects))
  assert(redirects.length <= 3)
  const client = url.startsWith('https') ? require('https') : require('http')
  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location
        assert(location && location.length > 0)
        const follow = httpGet(location, redirects.concat(location))
        resolve(follow)
      } else if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`))
      } else {
        resolve(response)
      }
    })
    request.on('error', reject)
  })
}

/**
 * @typedef {Object} ReleaseParameters
 * @property {NodeJS.Platform} platform
 * @property {CPUArchitecture} arch
 * @property {string} version - without leading "v"
 */

/**
 * @typedef {("arm" | "arm64" | "ia32" | "mips" | "mipsel" | "ppc" | "ppc64" | "s390" | "s390x" | "x32" | "x64")} CPUArchitecture
 */

/**
 * protoc-3.13.0-linux-aarch_64.zip
 * protoc-3.13.0-linux-ppcle_64.zip
 * protoc-3.13.0-linux-s390x.zip
 * protoc-3.13.0-linux-x86_32.zip
 * protoc-3.13.0-linux-x86_64.zip
 * protoc-3.13.0-osx-aarch_64.zip
 * protoc-3.13.0-osx-x86_64.zip
 * protoc-3.13.0-win32.zip
 * protoc-3.13.0-win64.zip
 *
 * @param {ReleaseParameters} params
 * @return {string}
 */
module.exports.makeReleaseName = function makeReleaseName (params) {
  let { platform, arch } = params
  let ext = ''
  if (platform.startsWith('win')) {
    platform = 'windows'
    ext = '.exe'
  }
  platform = `${platform[0].toUpperCase()}${platform.slice(1)}`

  if (arch === 'x64') {
    arch = 'x86_64'
  }

  return `${params.version}/buf-${platform}-${arch}${ext}`
}

/**
 * Reads the package json from the given path if it exists and
 * looks for config.protocVersion.
 *
 * If the package.json does not exist or does not specify a
 * config.protocVersion value, walk the file system up until
 * a package.json with a config.protocVersion is found.
 *
 * If nothing was found, return undefined.
 *
 * @param {string} cwd
 * @returns {string | undefined}
 */
module.exports.findBufVersionConfig = function findBufVersionConfig (cwd) {
  let version
  let dirname = cwd
  while (true) {
    version = tryReadBufVersion(path.join(dirname, 'package.json'))
    if (version !== undefined) {
      break
    }
    const parent = path.dirname(dirname)
    if (parent === dirname) {
      break
    }
    dirname = parent
  }
  return version
}

function tryReadBufVersion (pkgPath) {
  if (!fs.existsSync(pkgPath)) {
    return undefined
  }
  const json = fs.readFileSync(pkgPath, 'utf8')
  let pkg
  try {
    pkg = JSON.parse(json)
  } catch (e) {
    return undefined
  }
  if (typeof pkg === 'object' && typeof pkg.config === 'object' && pkg.config !== null) {
    if (Object.prototype.hasOwnProperty.call(pkg.config, 'bufVersion') && typeof pkg.config.bufVersion === 'string') {
      const version = pkg.config.bufVersion
      if (typeof version === 'string') {
        return version
      }
    }
  }
  return undefined
}

/**
 * @param {string|undefined} envPath from process.env.PATH
 * @returns {string|undefined}
 */
module.exports.findBufInPath = function (envPath) {
  if (typeof envPath !== 'string') {
    return undefined
  }
  const candidates = envPath.split(path.delimiter)
    .filter(p => !p.endsWith(`node_modules${path.sep}.bin`)) // make sure to exlude ...
    .filter(p => !p.endsWith(`.npm-global${path.sep}bin`)) // ...
    .map(p => path.join(p, os.platform().startsWith('win') ? 'buf.exe' : 'buf')) // we are looking for "buf"
    .map(p => p[0] === '~' ? path.join(os.homedir(), p.slice(1)) : p) // try expand "~"

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c
    }
  }
  return undefined
}
