const RU_MESSAGES = {
    LOG_RECEIPTS_LOADED_MESSAGE: 'Загружено квитанций',
    LOG_CONTEXT_MESSAGE: 'Контекст',
    LOG_PERIOD_MESSAGE: 'Период',
    LOG_PDF_RECEIPTS_COUNT_MESSAGE: 'PDF квитанции',
    LOG_CONDO_SAVE_MESSAGE: 'Сохранение',
    LOG_CONDO_UPDATED_RECEIPTS_COUNT_MESSAGE: 'Обновлено',
    LOG_CONDO_CREATED_RECEIPTS_COUNT_MESSAGE: 'Добавлено',
    LOG_CONDO_UNTOUCHED_RECEIPTS_COUNT_MESSAGE: 'Не изменились',
    LOG_CONDO_ERROR_RECEIPTS_COUNT_MESSAGE: 'Ошибок',
    PDF_CREATE_MESSAGE: 'Новых',
    PDF_UPDATE_MESSAGE: 'Обновлено',
    PDF_SKIPP_MESSAGE: 'Без изменений',
    PDF_ERROR_MESSAGE: 'Ошибок',
}

const EN_MESSAGES = {
    LOG_RECEIPTS_LOADED_MESSAGE: 'Receipts loaded',
    LOG_CONTEXT_MESSAGE: 'Context',
    LOG_PERIOD_MESSAGE: 'Period',
    LOG_PDF_RECEIPTS_COUNT_MESSAGE: 'PDF receipts',
    LOG_CONDO_SAVE_MESSAGE: 'Saving',
    LOG_CONDO_UPDATED_RECEIPTS_COUNT_MESSAGE: 'Updated',
    LOG_CONDO_CREATED_RECEIPTS_COUNT_MESSAGE: 'Created',
    LOG_CONDO_UNTOUCHED_RECEIPTS_COUNT_MESSAGE: 'Unchanged',
    LOG_CONDO_ERROR_RECEIPTS_COUNT_MESSAGE: 'Errors',
    PDF_CREATE_MESSAGE: 'Created',
    PDF_UPDATE_MESSAGE: 'Updated',
    PDF_SKIPP_MESSAGE: 'Unchanged',
    PDF_ERROR_MESSAGE: 'Errors',
}

const MESSAGES_BY_LANG = {
    ru: RU_MESSAGES,
    en: EN_MESSAGES,
}

function getLogMessages (lang = process.env.REPORT_LANG || process.env.LOG_LANG || 'ru') {
    const normalizedLang = String(lang).toLowerCase()
    return MESSAGES_BY_LANG[normalizedLang] || RU_MESSAGES
}

module.exports = {
    getLogMessages,
    SUPPORTED_REPORT_LANGUAGES: Object.keys(MESSAGES_BY_LANG),
}
