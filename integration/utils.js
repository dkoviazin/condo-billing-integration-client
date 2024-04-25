const originalFetch = require('cross-fetch')

const fetch = async (url, options, maxRetries = 5, timeout = 10000) => {
    let retries = 0
    while (retries < maxRetries) {
        try {
            const response = await Promise.race([
                originalFetch(url, options),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Request timeout')), timeout)
                ),
            ])
            if (response.ok) {
                return response
            } else {
                throw new Error(`Failed to request ${url}. Status: ${response.status}`)
            }
        } catch (error) {
            console.error(`Retry ${retries + 1} failed: ${error.message}`)
            retries++
        }
    }
    throw new Error(`Maximum retries (${maxRetries}) reached`)
}

module.exports = {
    fetch,
}