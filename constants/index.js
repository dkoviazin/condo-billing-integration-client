const { getLogMessages } = require('./log')
const CONDO = require('./condo')

const MAX_FETCH_RETRIES = 5
const REQUEST_ABORT_TIMEOUT = 5
const LOG_MESSAGES = getLogMessages()

module.exports = {
    ...LOG_MESSAGES,
    ...CONDO,
    MAX_FETCH_RETRIES,
    REQUEST_ABORT_TIMEOUT,
}
