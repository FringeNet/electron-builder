import { appBuilderPath } from "app-builder-bin"
import { retry, Nullish, safeStringifyJson } from "builder-util-runtime"
import * as chalk from "chalk"
import { ChildProcess, execFile, ExecFileOptions, SpawnOptions } from "child_process"
import { spawn as _spawn } from "cross-spawn"
import { createHash } from "crypto"
import _debug from "debug"
import { dump } from "js-yaml"
import * as path from "path"
import { install as installSourceMap } from "source-map-support"
import { getPath7za } from "./7za"
import { debug, log } from "./log"

if (process.env.JEST_WORKER_ID == null) {
  installSourceMap()
}

export { safeStringifyJson, retry } from "builder-util-runtime"
export { TmpDir } from "temp-file"
export * from "./arch"
export { Arch, archFromString, ArchType, defaultArchFromString, getArchCliNames, getArchSuffix, toLinuxArchString } from "./arch"
export { AsyncTaskManager } from "./asyncTaskManager"
export { DebugLogger } from "./DebugLogger"
export * from "./log"
export { httpExecutor, NodeHttpExecutor } from "./nodeHttpExecutor"
export * from "./promise"

export { asArray } from "builder-util-runtime"
export * from "./fs"

export { deepAssign } from "./deepAssign"

export { getPath7x, getPath7za } from "./7za"

export const debug7z = _debug("electron-builder:7z")

export function serializeToYaml(object: any, skipInvalid = false, noRefs = false) {
  return dump(object, {
    lineWidth: 8000,
    skipInvalid,
    noRefs,
  })
}

export function removePassword(input: string): string {
  const blockList = ["--accessKey", "--secretKey", "-P", "-p", "-pass", "-String", "/p", "pass:"]

  // Create a regex pattern that supports:
  //   - space-separated unquoted values: --key value
  //   - quoted values: --key "value with spaces" or 'value with spaces'
  const blockPattern = new RegExp(`(${blockList.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*(?:(["'])(.*?)\\2|([^\\s]+))`, "g")

  input = input.replace(blockPattern, (_match, prefix, quote, quotedVal, unquotedVal) => {
    const value = quotedVal ?? unquotedVal

    if (prefix.trim() === "/p" && value.startsWith("\\\\Mac\\Host\\\\")) {
      return `${prefix} ${quote ?? ""}${value}${quote ?? ""}`
    }

    const hashed = createHash("sha256").update(value).digest("hex")
    return `${prefix} ${quote ?? ""}${hashed} (sha256 hash)${quote ?? ""}`
  })

  // Also handle `/b ... /c` block format
  return input.replace(/(\/b\s+)(.*?)(\s+\/c)/g, (_match, p1, p2, p3) => {
    const hashed = createHash("sha256").update(p2).digest("hex")
    return `${p1}${hashed} (sha256 hash)${p3}`
  })
}

function getProcessEnv(env: Record<string, string | undefined> | Nullish): NodeJS.ProcessEnv | undefined {
  if (process.platform === "win32") {
    return env == null ? undefined : env
  }

  const finalEnv = {
    ...(env || process.env),
  }

  // without LC_CTYPE dpkg can returns encoded unicode symbols
  // set LC_CTYPE to avoid crash https://github.com/electron-userland/electron-builder/issues/503 Even "en_DE.UTF-8" leads to error.
  const locale = process.platform === "linux" ? process.env.LANG || "C.UTF-8" : "en_US.UTF-8"
  finalEnv.LANG = locale
  finalEnv.LC_CTYPE = locale
  finalEnv.LC_ALL = locale
  return finalEnv
}

export function exec(file: string, args?: Array<string> | null, options?: ExecFileOptions, isLogOutIfDebug = true): Promise<string> {
  if (log.isDebugEnabled) {
    const logFields: any = {
      file,
      args: args == null ? "" : removePassword(args.join(" ")),
    }
    if (options != null) {
      if (options.cwd != null) {
        logFields.cwd = options.cwd
      }

      if (options.env != null) {
        const diffEnv = { ...options.env }
        for (const name of Object.keys(process.env)) {
          if (process.env[name] === options.env[name]) {
            delete diffEnv[name]
          }
        }
        logFields.env = safeStringifyJson(diffEnv)
      }
    }

    log.debug(logFields, "executing")
  }

  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        ...options,
        maxBuffer: 1000 * 1024 * 1024,
        env: getProcessEnv(options == null ? null : options.env),
      },
      (error, stdout, stderr) => {
        if (error == null) {
          if (isLogOutIfDebug && log.isDebugEnabled) {
            const logFields: any = {
              file,
            }
            if (stdout.length > 0) {
              logFields.stdout = stdout
            }
            if (stderr.length > 0) {
              logFields.stderr = stderr
            }

            log.debug(logFields, "executed")
          }
          resolve(stdout.toString())
        } else {
          let message = chalk.red(removePassword(`Exit code: ${(error as any).code}. ${error.message}`))
          if (stdout.length !== 0) {
            if (file.endsWith("wine")) {
              stdout = stdout.toString()
            }
            message += `\n${chalk.yellow(stdout.toString())}`
          }
          if (stderr.length !== 0) {
            if (file.endsWith("wine")) {
              stderr = stderr.toString()
            }
            message += `\n${chalk.red(stderr.toString())}`
          }

          // TODO: switch to ECMA Script 2026 Error class with `cause` property to return stack trace
          reject(new ExecError(file, (error as any).code, message, "", `${error.code || ExecError.code}`))
        }
      }
    )
  })
}

export interface ExtraSpawnOptions {
  isPipeInput?: boolean
}

function logSpawn(command: string, args: Array<string>, options: SpawnOptions) {
  // use general debug.enabled to log spawn, because it doesn't produce a lot of output (the only line), but important in any case
  if (!log.isDebugEnabled) {
    return
  }

  const argsString = removePassword(args.join(" "))
  const logFields: any = {
    command: command + " " + (command === "docker" ? argsString : removePassword(argsString)),
  }
  if (options != null && options.cwd != null) {
    logFields.cwd = options.cwd
  }
  log.debug(logFields, "spawning")
}

export function doSpawn(command: string, args: Array<string>, options?: SpawnOptions, extraOptions?: ExtraSpawnOptions): ChildProcess {
  if (options == null) {
    options = {}
  }

  options.env = getProcessEnv(options.env)

  if (options.stdio == null) {
    const isDebugEnabled = debug.enabled
    // do not ignore stdout/stderr if not debug, because in this case we will read into buffer and print on error
    options.stdio = [extraOptions != null && extraOptions.isPipeInput ? "pipe" : "ignore", isDebugEnabled ? "inherit" : "pipe", isDebugEnabled ? "inherit" : "pipe"] as any
  }

  logSpawn(command, args, options)
  try {
    return _spawn(command, args, options)
  } catch (e: any) {
    throw new Error(`Cannot spawn ${command}: ${e.stack || e}`)
  }
}

export function spawnAndWrite(command: string, args: Array<string>, data: string, options?: SpawnOptions) {
  const childProcess = doSpawn(command, args, options, { isPipeInput: true })
  const timeout = setTimeout(() => childProcess.kill(), 4 * 60 * 1000)
  return new Promise<any>((resolve, reject) => {
    handleProcess(
      "close",
      childProcess,
      command,
      () => {
        try {
          clearTimeout(timeout)
        } finally {
          resolve(undefined)
        }
      },
      error => {
        try {
          clearTimeout(timeout)
        } finally {
          reject(error)
        }
      }
    )

    childProcess.stdin!.end(data)
  })
}

export function spawn(command: string, args?: Array<string> | null, options?: SpawnOptions, extraOptions?: ExtraSpawnOptions): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    handleProcess("close", doSpawn(command, args || [], options, extraOptions), command, resolve, reject)
  })
}

function handleProcess(event: string, childProcess: ChildProcess, command: string, resolve: ((value?: any) => void) | null, reject: (reason?: any) => void) {
  childProcess.on("error", reject)

  let out = ""
  if (childProcess.stdout != null) {
    childProcess.stdout.on("data", (data: string) => {
      out += data
    })
  }

  let errorOut = ""
  if (childProcess.stderr != null) {
    childProcess.stderr.on("data", (data: string) => {
      errorOut += data
    })
  }

  childProcess.once(event, (code: number) => {
    if (log.isDebugEnabled) {
      const fields: any = {
        command: path.basename(command),
        code,
        pid: childProcess.pid,
      }
      if (out.length > 0) {
        fields.out = out
      }
      log.debug(fields, "exited")
    }

    if (code === 0) {
      if (resolve != null) {
        resolve(out)
      }
    } else {
      reject(new ExecError(command, code, out, errorOut))
    }
  })
}

function formatOut(text: string, title: string) {
  return text.length === 0 ? "" : `\n${title}:\n${text}`
}

export class ExecError extends Error {
  alreadyLogged = false

  static code = "ERR_ELECTRON_BUILDER_CANNOT_EXECUTE"

  constructor(
    command: string,
    readonly exitCode: number,
    out: string,
    errorOut: string,
    code = ExecError.code
  ) {
    super(`${command} process failed ${code}${formatOut(String(exitCode), "Exit code")}${formatOut(out, "Output")}${formatOut(errorOut, "Error output")}`)
    ;(this as NodeJS.ErrnoException).code = code
  }
}

export function use<T, R>(value: T | Nullish, task: (value: T) => R): R | null {
  return value == null ? null : task(value)
}

export function isEmptyOrSpaces(s: string | Nullish): s is "" | Nullish {
  return s == null || s.trim().length === 0
}

export function isTokenCharValid(token: string) {
  return /^[.\w/=+-]+$/.test(token)
}

export function addValue<K, T>(map: Map<K, Array<T>>, key: K, value: T) {
  const list = map.get(key)
  if (list == null) {
    map.set(key, [value])
  } else if (!list.includes(value)) {
    list.push(value)
  }
}

export function replaceDefault(inList: Array<string> | Nullish, defaultList: Array<string>): Array<string> {
  if (inList == null || (inList.length === 1 && inList[0] === "default")) {
    return defaultList
  }

  const index = inList.indexOf("default")
  if (index >= 0) {
    const list = inList.slice(0, index)
    list.push(...defaultList)
    if (index !== inList.length - 1) {
      list.push(...inList.slice(index + 1))
    }
    inList = list
  }
  return inList
}

export function getPlatformIconFileName(value: string | Nullish, isMac: boolean) {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }

  if (!value.includes(".")) {
    return `${value}.${isMac ? "icns" : "ico"}`
  }

  return value.replace(isMac ? ".ico" : ".icns", isMac ? ".icns" : ".ico")
}

export function isPullRequest() {
  // TRAVIS_PULL_REQUEST is set to the pull request number if the current job is a pull request build, or false if it’s not.
  function isSet(value: string | undefined) {
    // value can be or null, or empty string
    return value && value !== "false"
  }

  return (
    isSet(process.env.TRAVIS_PULL_REQUEST) ||
    isSet(process.env.CIRCLE_PULL_REQUEST) ||
    isSet(process.env.BITRISE_PULL_REQUEST) ||
    isSet(process.env.APPVEYOR_PULL_REQUEST_NUMBER) ||
    isSet(process.env.GITHUB_BASE_REF)
  )
}

export function isEnvTrue(value: string | Nullish) {
  if (value != null) {
    value = value.trim()
  }
  return value === "true" || value === "" || value === "1"
}

export class InvalidConfigurationError extends Error {
  constructor(message: string, code = "ERR_ELECTRON_BUILDER_INVALID_CONFIGURATION") {
    super(message)
    ;(this as NodeJS.ErrnoException).code = code
  }
}

export async function executeAppBuilder(
  args: Array<string>,
  childProcessConsumer?: (childProcess: ChildProcess) => void,
  extraOptions: SpawnOptions = {},
  maxRetries = 0
): Promise<string> {
  const command = appBuilderPath
  const env: any = {
    ...process.env,
    SZA_PATH: await getPath7za(),
    FORCE_COLOR: chalk.level === 0 ? "0" : "1",
  }
  const cacheEnv = process.env.ELECTRON_BUILDER_CACHE
  if (cacheEnv != null && cacheEnv.length > 0) {
    env.ELECTRON_BUILDER_CACHE = path.resolve(cacheEnv)
  }

  if (extraOptions.env != null) {
    Object.assign(env, extraOptions.env)
  }

  function runCommand() {
    return new Promise<string>((resolve, reject) => {
      const childProcess = doSpawn(command, args, {
        stdio: ["ignore", "pipe", process.stdout],
        ...extraOptions,
        env,
      })
      if (childProcessConsumer != null) {
        childProcessConsumer(childProcess)
      }
      handleProcess("close", childProcess, command, resolve, error => {
        if (error instanceof ExecError && error.exitCode === 2) {
          error.alreadyLogged = true
        }
        reject(error)
      })
    })
  }

  if (maxRetries === 0) {
    return runCommand()
  } else {
    return retry(runCommand, { retries: maxRetries, interval: 1000 })
  }
}
