Клиент для написания интеграций с информационными и биллинг системами для CONDO

Запуск любой интеграции выглядит как консольная команда:

node index.js -c [ID BILLING контекста] -p [PERIOD: 2026-04-01]

Если в переменных окружения есть настройка для телеграмма, то отправляется сообщений в виде
```
ООО "СТАТУС ГОРОДА" (6417001343)
Контекст : 225f56fa-da88-49d2-a5ef-afg2e3060168
Период : 2026-01-01

Загружено квитанций (70) : 28.72 с

Сохранение : 1.41 с
Добавлено : 0
Обновлено : 0
Ошибок : 0
Не изменились : 70

PDF квитанции : 2.36 с
Без изменений : 70
```

Любая интеграция должна поддержать интерфейс:

```js
class Integration {

    /**
     * Retrieves all receipts from the integration.
     *
     * @async
     * @param {Object} { tin: String, period: String }
     * @returns {Promise<{ receipts: Array<Object> }>} An object containing an array of receipt objects.
     * @throws {Error} Throws an error if the method is not implemented.
     * @abstract
     */
    async getAllReceipts ({ tin, period }) {
        throw new Error(NOT_IMPLEMENTED_ERROR)
    }

    /**
     * Checks if a receipt has a PDF file.
     *
     * @param {Object} receipt - The receipt object.
     * @returns {boolean} Returns true if the receipt has a PDF file, otherwise false.
     * @throws {Error} Throws an error if the method is not overridden.
     * @abstract
     */
    hasPDFFile (receipt) {}

    /**
     * Retrieves the sensitive data  for a given integration receipt.
     *
     * @async
     * @param {Object} receipt - The integration receipt object.
     * @returns {Promise<Buffer|null>} A stream representing the sensitive data, or null if no sensitive data is available.
     * @throws {Error} Throws an error if the method is not overridden.
     * @abstract
     */
    async getPDFBuffer (receipt) {}
}
```

