const test = require('node:test')
const assert = require('node:assert/strict')

const { FetchRetryError, fetchWithRetry } = require('./fetchWithRetry')

function okResponse (status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        body: {
            cancel: async () => undefined,
        },
    }
}

function redirectResponse (location, status = 302) {
    const headers = new Headers({ location })
    return {
        ok: false,
        status,
        headers,
        body: {
            cancel: async () => undefined,
        },
    }
}

function createNetworkError (code) {
    const cause = new Error(code)
    cause.code = code

    const error = new TypeError('fetch failed')
    error.cause = cause
    return error
}

function createMockFetch (...steps) {
    const calls = []
    const fn = async (url, options) => {
        calls.push({ url, options })
        if (steps.length === 0) {
            throw new Error('Unexpected fetch call')
        }
        const step = steps.shift()
        if (step instanceof Error) {
            throw step
        }
        if (typeof step === 'function') {
            return step(url, options)
        }
        return step
    }

    fn.calls = calls
    return fn
}

test('returns response on first successful attempt', async () => {
    const fetchMock = createMockFetch(okResponse(200))

    const response = await fetchWithRetry('https://example.com', {}, {
        fetchImpl: fetchMock,
        timeoutMs: 50,
        retryDelayMs: 1,
        maxRetries: 5,
    })

    assert.equal(response.status, 200)
    assert.equal(fetchMock.calls.length, 1)
})

test('retries on network errors and then succeeds', async () => {
    const fetchMock = createMockFetch(
        createNetworkError('ECONNRESET'),
        createNetworkError('ETIMEDOUT'),
        okResponse(200),
    )

    const response = await fetchWithRetry('https://example.com/retry', {}, {
        fetchImpl: fetchMock,
        timeoutMs: 50,
        retryDelayMs: 1,
        maxRetries: 5,
    })

    assert.equal(response.status, 200)
    assert.equal(fetchMock.calls.length, 3)
})

test('retries on timeout-like network errors and then succeeds', async () => {
    const fetchMock = createMockFetch(
        createNetworkError('UND_ERR_HEADERS_TIMEOUT'),
        okResponse(200),
    )

    const response = await fetchWithRetry('https://example.com/timeout', {}, {
        fetchImpl: fetchMock,
        timeoutMs: 50,
        retryDelayMs: 1,
        maxRetries: 5,
    })

    assert.equal(response.status, 200)
    assert.equal(fetchMock.calls.length, 2)
})

test('throws FetchRetryError when max retries are exceeded', async () => {
    const fetchMock = createMockFetch(
        createNetworkError('ENOTFOUND'),
        createNetworkError('ENOTFOUND'),
        createNetworkError('ENOTFOUND'),
    )

    await assert.rejects(
        fetchWithRetry('https://example.com/fail', {}, {
            fetchImpl: fetchMock,
            timeoutMs: 20,
            retryDelayMs: 1,
            maxRetries: 2,
        }),
        {
            name: 'FetchRetryError',
            retries: 2,
            attempts: 3,
        },
    )

    assert.equal(fetchMock.calls.length, 3)
})

test('does not retry on non-ok http response by default', async () => {
    const fetchMock = createMockFetch(okResponse(500))

    await assert.rejects(
        fetchWithRetry('https://example.com/http', {}, {
            fetchImpl: fetchMock,
            timeoutMs: 20,
            retryDelayMs: 1,
            maxRetries: 5,
        }),
        FetchRetryError,
    )

    assert.equal(fetchMock.calls.length, 1)
})

test('stops immediately on external abort signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('manual abort'))

    const fetchMock = createMockFetch(
        async () => {
            const abortError = new Error('The operation was aborted')
            abortError.name = 'AbortError'
            throw abortError
        },
    )

    await assert.rejects(
        fetchWithRetry('https://example.com/abort', {
            signal: controller.signal,
        }, {
            fetchImpl: fetchMock,
        }),
        {
            message: 'manual abort',
        },
    )

    assert.equal(fetchMock.calls.length, 1)
})

test('keeps Authorization header across same-origin redirects', async () => {
    const auth = 'Basic dXNlcjpwYXNz'
    const fetchMock = createMockFetch(
        redirectResponse('/v2/resource'),
        okResponse(200),
    )

    const response = await fetchWithRetry('https://example.com/v1/resource', {
        headers: {
            Authorization: auth,
        },
    }, {
        fetchImpl: fetchMock,
        timeoutMs: 100,
        retryDelayMs: 1,
        maxRetries: 1,
    })

    assert.equal(response.status, 200)
    assert.equal(fetchMock.calls.length, 2)
    assert.equal(fetchMock.calls[0].options.headers.Authorization, auth)
    assert.equal(fetchMock.calls[1].options.headers.Authorization, auth)
    assert.equal(fetchMock.calls[1].url, 'https://example.com/v2/resource')
})
