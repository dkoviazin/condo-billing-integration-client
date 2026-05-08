const RETRYABLE_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
])

function normalizePositiveInteger(value, fallback) {
    const num = Number(value)
    if (!Number.isFinite(num) || num < 0) return fallback
    return Math.floor(num)
}

function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))
}

function isRetryableNetworkError(error) {
    if (!error || isAbortError(error)) return false

    const errorCode = error.code || error?.cause?.code
    if (errorCode && RETRYABLE_ERROR_CODES.has(errorCode)) {
        return true
    }

    return error instanceof TypeError
}

function createTimeoutSignal(timeoutMs) {
    return AbortSignal.timeout(timeoutMs)
}

function mergeSignals(mainSignal, timeoutSignal) {
    if (!mainSignal) return timeoutSignal
    return AbortSignal.any([mainSignal, timeoutSignal])
}

function abortReasonToError(reason) {
    if (reason instanceof Error) {
        return reason
    }

    const error = new Error('The operation was aborted')
    error.name = 'AbortError'
    return error
}

function wait(ms, signal) {
    if (!ms) return Promise.resolve()

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortReasonToError(signal.reason))
            return
        }

        const timeoutId = setTimeout(() => {
            cleanup()
            resolve()
        }, ms)

        const onAbort = () => {
            clearTimeout(timeoutId)
            cleanup()
            reject(abortReasonToError(signal.reason))
        }

        const cleanup = () => {
            signal?.removeEventListener('abort', onAbort)
        }

        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

class FetchRetryError extends Error {
    constructor(message, details) {
        super(message)
        this.name = 'FetchRetryError'
        this.url = details?.url
        this.attempts = details?.attempts
        this.retries = details?.retries
        this.timeoutMs = details?.timeoutMs
        this.retryDelayMs = details?.retryDelayMs
        this.cause = details?.cause
    }
}

function createHttpError(response, url) {
    const error = new Error(`Request failed for ${url}. Status: ${response.status}`)
    error.name = 'FetchHttpError'
    error.status = response.status
    error.response = response
    return error
}

function shouldRetryByStatus(response, retryOnStatuses) {
    if (!Array.isArray(retryOnStatuses) || retryOnStatuses.length === 0) {
        return false
    }

    return retryOnStatuses.includes(response.status)
}

function isRetryableFailure(error, { requestSignal, timeoutSignal }) {
    if (requestSignal?.aborted) return false
    if (timeoutSignal?.aborted) return true
    return isRetryableNetworkError(error)
}

async function fetchWithRetry(url, options = {}, config = {}) {
    const fetchImpl = config.fetchImpl || globalThis.fetch
    const maxRetries = normalizePositiveInteger(config.maxRetries, 5)
    const timeoutMs = normalizePositiveInteger(config.timeoutMs, 10_000)
    const retryDelayMs = normalizePositiveInteger(config.retryDelayMs, 1_000)
    const retryOnStatuses = Array.isArray(config.retryOnStatuses) ? config.retryOnStatuses : []

    if (typeof fetchImpl !== 'function') {
        throw new TypeError('fetchWithRetry requires a valid fetch implementation')
    }

    let retries = 0
    let attempts = 0
    let lastError = null

    while (retries <= maxRetries) {
        const timeoutSignal = createTimeoutSignal(timeoutMs)
        const mergedSignal = mergeSignals(options.signal, timeoutSignal)

        attempts += 1

        try {
            const response = await fetchImpl(url, {
                ...options,
                signal: mergedSignal,
            })

            if (!response.ok) {
                if (shouldRetryByStatus(response, retryOnStatuses)) {
                    if (typeof response.body?.cancel === 'function') {
                        await response.body.cancel().catch(() => {})
                    }
                    throw createHttpError(response, url)
                }

                throw createHttpError(response, url)
            }

            return response
        } catch (error) {
            if (options.signal?.aborted) {
                throw abortReasonToError(options.signal.reason)
            }

            const retryable = isRetryableFailure(error, {
                requestSignal: options.signal,
                timeoutSignal,
            })

            if (!retryable || retries >= maxRetries) {
                throw new FetchRetryError(
                    `Failed to fetch ${url} after ${attempts} attempts (retries: ${retries})`,
                    {
                        url,
                        attempts,
                        retries,
                        timeoutMs,
                        retryDelayMs,
                        cause: error,
                    }
                )
            }

            lastError = error
            retries += 1
            await wait(retryDelayMs, options.signal)
        }
    }

    throw new FetchRetryError(
        `Failed to fetch ${url} after ${attempts} attempts (retries: ${retries})`,
        {
            url,
            attempts,
            retries,
            timeoutMs,
            retryDelayMs,
            cause: lastError,
        }
    )
}

module.exports = {
    RETRYABLE_ERROR_CODES,
    FetchRetryError,
    fetchWithRetry,
    isRetryableNetworkError,
}
