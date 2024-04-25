const { fetch }  = require('./utils')

const { isNil} = require('lodash')

const { url, chatId } = process.env['NOTIFY_TELEGRAM'] ? JSON.parse(process.env['NOTIFY_TELEGRAM']) : {}

class Logger {

    timeStart
    logs = []

    constructor () {
        this.startTimer()
        this.logs = []
    }

    startTimer () {
        this.timeStart = process.hrtime()
    }

    stopTimer () {
        const timeEnd = process.hrtime(this.timeStart)
        const time = ((timeEnd[0] * 1000 + timeEnd[1] / 1e6) / 1000).toFixed(2)
        this.timeStart = process.hrtime()
        return `${time} с`
    }

    addLog (name, value ) {
        const log = `<b>${name}</b> ${!isNil(value) ? ': ' + value : ''}`
        console.log(log)
        this.logs.push(log)
    }

    addSeparator () {
        this.logs.push('')
    }

    async notify () {
        await sendNotificationMessage(this.logs.join('\n'))
    }

}


const sendNotificationMessage = async (message) => {
    try {
        const response = await fetch(url, {
            method: 'POST',
            mode: 'cors',
            cache: 'no-cache',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
            },
            redirect: 'follow',
            referrerPolicy: 'no-referrer',
            body: JSON.stringify({
                message,
                chatId: chatId,
            }),
        })
        if (!response.ok) {
            console.error({ msg: 'Failed to use chat bot' })
        }
        return await response.json()
    } catch (err) {
        console.error({ msg: 'Notification bot is not responding', payload: { err } })
    }
}

module.exports = {
    Logger,
    sendNotificationMessage,
}