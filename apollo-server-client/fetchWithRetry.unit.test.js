const { FetchRetryError, fetchWithRetry } = require('./fetchWithRetry')

function okResponse(status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        body: {
            cancel: jest.fn().mockResolvedValue(undefined),
        },
    }
}

function createNetworkError(code) {
    const cause = new Error(code)
    cause.code = code

    const error = new TypeError('fetch failed')
    error.cause = cause
    return error
}

describe('fetchWithRetry', () => {
    test('returns response on first successful attempt', async () => {
        const fetchMock = jest.fn().mockResolvedValue(okResponse(200))

        const response = await fetchWithRetry('https://example.com', {}, {
            fetchImpl: fetchMock,
            timeoutMs: 50,
            retryDelayMs: 1,
            maxRetries: 5,
        })

        expect(response.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('retries on network errors and then succeeds', async () => {
        const fetchMock = jest.fn()
            .mockRejectedValueOnce(createNetworkError('ECONNRESET'))
            .mockRejectedValueOnce(createNetworkError('ETIMEDOUT'))
            .mockResolvedValueOnce(okResponse(200))

        const response = await fetchWithRetry('https://example.com/retry', {}, {
            fetchImpl: fetchMock,
            timeoutMs: 50,
            retryDelayMs: 1,
            maxRetries: 5,
        })

        expect(response.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    test('retries on timeout via abort signal and then succeeds', async () => {
        const fetchMock = jest.fn()
            .mockImplementationOnce((_url, { signal }) => new Promise((_, reject) => {
                const onAbort = () => {
                    const abortError = new Error('timed out')
                    abortError.name = 'AbortError'
                    reject(abortError)
                }
                signal.addEventListener('abort', onAbort, { once: true })
            }))
            .mockResolvedValueOnce(okResponse(200))

        const response = await fetchWithRetry('https://example.com/timeout', {}, {
            fetchImpl: fetchMock,
            timeoutMs: 10,
            retryDelayMs: 1,
            maxRetries: 5,
        })

        expect(response.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('throws FetchRetryError when max retries are exceeded', async () => {
        const fetchMock = jest.fn().mockRejectedValue(createNetworkError('ENOTFOUND'))

        await expect(
            fetchWithRetry('https://example.com/fail', {}, {
                fetchImpl: fetchMock,
                timeoutMs: 20,
                retryDelayMs: 1,
                maxRetries: 2,
            })
        ).rejects.toMatchObject({
            name: 'FetchRetryError',
            retries: 2,
            attempts: 3,
        })

        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    test('does not retry on non-ok http response by default', async () => {
        const fetchMock = jest.fn().mockResolvedValue(okResponse(500))

        await expect(
            fetchWithRetry('https://example.com/http', {}, {
                fetchImpl: fetchMock,
                timeoutMs: 20,
                retryDelayMs: 1,
                maxRetries: 5,
            })
        ).rejects.toBeInstanceOf(FetchRetryError)

        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('stops immediately on external abort signal', async () => {
        const controller = new AbortController()
        controller.abort(new Error('manual abort'))

        const fetchMock = jest.fn()

        await expect(
            fetchWithRetry('https://example.com/abort', {
                signal: controller.signal,
            }, {
                fetchImpl: fetchMock,
            })
        ).rejects.toMatchObject({
            message: 'manual abort',
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
