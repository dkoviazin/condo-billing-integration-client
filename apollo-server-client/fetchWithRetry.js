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
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

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

function hasAuthorizationHeader(headers) {
    if (!headers) return false
    if (headers instanceof Headers) {
        return headers.has('authorization')
    }
    if (Array.isArray(headers)) {
        return headers.some(([key]) => String(key).toLowerCase() === 'authorization')
    }
    if (typeof headers === 'object') {
        return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
    }
    return false
}

function removeAuthorizationHeader(headers) {
    if (!headers) return headers
    if (headers instanceof Headers) {
        const cloned = new Headers(headers)
        cloned.delete('authorization')
        return cloned
    }
    if (Array.isArray(headers)) {
        return headers.filter(([key]) => String(key).toLowerCase() !== 'authorization')
    }
    if (typeof headers === 'object') {
        return Object.fromEntries(
            Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization')
        )
    }
    return headers
}

function removeBodyHeaders(headers) {
    if (!headers) return headers
    const removedHeaderNames = new Set(['content-length', 'content-type'])
    if (headers instanceof Headers) {
        const cloned = new Headers(headers)
        removedHeaderNames.forEach((name) => cloned.delete(name))
        return cloned
    }
    if (Array.isArray(headers)) {
        return headers.filter(([key]) => !removedHeaderNames.has(String(key).toLowerCase()))
    }
    if (typeof headers === 'object') {
        return Object.fromEntries(
            Object.entries(headers).filter(([key]) => !removedHeaderNames.has(key.toLowerCase()))
        )
    }
    return headers
}

function isRedirectResponse(response) {
    return REDIRECT_STATUSES.has(response.status) && Boolean(response.headers?.get('location'))
}

function resolveRedirectUrl(fromUrl, location) {
    try {
        return new URL(location, fromUrl).toString()
    } catch (_error) {
        return null
    }
}

function isSameOrigin(leftUrl, rightUrl) {
    return new URL(leftUrl).origin === new URL(rightUrl).origin
}

function applyRedirectRequestOptions(options, status) {
    const method = String(options.method || 'GET').toUpperCase()
    if ((status === 301 || status === 302) && method === 'POST') {
        return {
            ...options,
            method: 'GET',
            body: undefined,
            headers: removeBodyHeaders(options.headers),
        }
    }
    if (status === 303 && method !== 'HEAD') {
        return {
            ...options,
            method: 'GET',
            body: undefined,
            headers: removeBodyHeaders(options.headers),
        }
    }
    return options
}

async function fetchFollowingRedirects(fetchImpl, url, options, signal, config) {
    const maxRedirects = normalizePositiveInteger(config.maxRedirects, 5)
    let redirectCount = 0
    let currentUrl = url
    let currentOptions = options

    while (true) {
        const response = await fetchImpl(currentUrl, {
            ...currentOptions,
            signal,
        })

        if (!isRedirectResponse(response)) {
            return { response, finalUrl: currentUrl }
        }

        if (redirectCount >= maxRedirects) {
            throw new Error(`Too many redirects for ${url}. maxRedirects: ${maxRedirects}`)
        }

        if (typeof response.body?.cancel === 'function') {
            await response.body.cancel().catch(() => {})
        }

        const nextUrl = resolveRedirectUrl(currentUrl, response.headers.get('location'))
        if (!nextUrl) {
            return { response, finalUrl: currentUrl }
        }

        const nextOptions = applyRedirectRequestOptions(currentOptions, response.status)
        currentOptions = isSameOrigin(currentUrl, nextUrl)
            ? nextOptions
            : { ...nextOptions, headers: removeAuthorizationHeader(nextOptions.headers) }
        currentUrl = nextUrl
        redirectCount += 1
    }
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

    const shouldHandleRedirectsManually =
        hasAuthorizationHeader(options.headers) &&
        (options.redirect === undefined || options.redirect === 'follow')

    while (retries <= maxRetries) {
        const timeoutSignal = createTimeoutSignal(timeoutMs)
        const mergedSignal = mergeSignals(options.signal, timeoutSignal)

        attempts += 1

        try {
            const requestOptions = shouldHandleRedirectsManually
                ? { ...options, redirect: 'manual' }
                : options
            const { response, finalUrl } = shouldHandleRedirectsManually
                ? await fetchFollowingRedirects(fetchImpl, url, requestOptions, mergedSignal, config)
                : {
                    response: await fetchImpl(url, {
                        ...requestOptions,
                        signal: mergedSignal,
                    }),
                    finalUrl: url,
                }

            if (!response.ok) {
                if (shouldRetryByStatus(response, retryOnStatuses)) {
                    if (typeof response.body?.cancel === 'function') {
                        await response.body.cancel().catch(() => {})
                    }
                    throw createHttpError(response, finalUrl)
                }

                throw createHttpError(response, finalUrl)
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
