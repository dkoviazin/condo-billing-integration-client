const { Duplex } = require('stream')

const hummus = require('hummus')
const iconv = require('iconv-lite')
const jschardet = require('jschardet')
const MemoryStream = require('memory-streams')

const extractText = require('./lib/text-extraction')
const { PDFDocument } = require('pdf-lib')

/**
 * Converts a Buffer content to a Readable Stream.
 *
 * @function
 * @param {Buffer} content - The Buffer content to be converted to a stream.
 * @returns {module:stream.internal.Duplex} - A Readable Stream containing the provided Buffer content.
 */
function bufferToStream (content) {
    let tmp = new Duplex()
    tmp.push(content)
    tmp.push(null)
    return tmp
}
/**
 * Converts a Readable Stream to a Buffer.
 *
 * @function
 * @async
 * @param {Stream} stream - The Readable Stream to be converted to a Buffer.
 * @returns {Promise<Buffer>} - A Promise that resolves with the concatenated Buffer from the stream.
 * @rejects {Error} - If there is an error during the stream conversion.
 */
const stream2buffer = async (stream) => new Promise((resolve, reject) => {
    const _buf = []
    stream.on('data', (chunk) => _buf.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(_buf)))
    stream.on('error', (err) => reject(err))
})

const bufferToOctal = (buffer) => {
    let octalRepresentation = ''
    for (const byte of buffer) {
        octalRepresentation += `\\${byte.toString(8).padStart(3, '0')}`
    }
    return octalRepresentation
}


const convertPDF = async (bytes) => {
    const pdfDoc = await PDFDocument.create()
    const originalPDF = await PDFDocument.load(bytes)
    const [firstPage] = await pdfDoc.copyPages(originalPDF, [0])
    pdfDoc.addPage(firstPage)
    return await pdfDoc.save()
}


class PdfEditor {

    constructor (buffer, texts = []) {
        this.originalBuffer = buffer
        this.buffer = null
        this.texts = texts
    }

    async init () {
        if (!this.buffer) {
            this.buffer = await convertPDF(this.originalBuffer)
        }
    }

    async process () {
        return await this.removeTextsAndImages()
    }

    extractText () {
        const pdfReader = hummus.createReader(new hummus.PDFRStreamForBuffer(this.buffer))
        const [pagesPlacements] = extractText(pdfReader)
        return pagesPlacements
    }

    replaceNode (streamContent, node) {
        let { text, chunks, bytes } = node
        if (!Array.isArray(chunks)) {
            chunks = [chunks]
        }
        const octalString = chunks.map(chunk => (typeof chunk === 'object') ?
            `(${bufferToOctal(chunk.asBytes)})` :
            !isNaN(Number(chunk)) ? Number(chunk).toFixed(2) : chunk.toString()).join('')
        const hexString = `<${Buffer.from(bytes).toString('hex')}>`
        return streamContent
            .split(hexString).join('')
            .split(hexString.toUpperCase()).join('')
            .split(text).join('')
            .split(octalString).join('')
    }

    async removeTextsAndImages () {
        const writer = new MemoryStream.WritableStream()
        const pagesPlacements = this.extractText()
        const nodesToClear = pagesPlacements.filter(({ text }) => text && this.texts.find(sensitiveData => text.indexOf(sensitiveData) !== -1 ))
        const modPdfWriter = hummus.createWriterToModify(
            new hummus.PDFRStreamForBuffer(this.buffer),
            new hummus.PDFStreamForResponse(writer)
        )
        const numPages = modPdfWriter.createPDFCopyingContextForModifiedFile().getSourceDocumentParser().getPagesCount()
        for (let page = 0; page < numPages; page++) {
            const copyingContext = modPdfWriter.createPDFCopyingContextForModifiedFile()
            const objectsContext = modPdfWriter.getObjectsContext()
            const pageObject = copyingContext.getSourceDocumentParser().parsePage(page)
            const pageJSObject = pageObject.getDictionary().toJSObject()
            const textStream = copyingContext.getSourceDocumentParser().queryDictionaryObject(pageObject.getDictionary(), 'Contents')

            const textObjectID = pageObject.getDictionary().toJSObject().Contents.getObjectID()

            let data = []
            const readStream = copyingContext.getSourceDocumentParser().startReadingFromStream(textStream)
            while (readStream.notEnded()) {
                const readData = readStream.read(10000)
                data = data.concat(readData)
            }
            let { encoding } = jschardet.detect(Buffer.from(data))
            let pdfPageAsString = iconv.decode(Buffer.from(data), encoding)
            let images = []
            try {
                images = Object.keys(pageJSObject.Resources.toJSObject().XObject.toJSObject())
            } catch (err) {
                console.log('NO IMAGES - WILL REMOVE ALL LINES')
                // TODO: Find a better solution to remove vector graphics QR CODE
                pdfPageAsString = pdfPageAsString.replace(/[0-9.\s]+m[0-9.\s]+l[0-9.\s]+l[0-9.\s]+l/g, '')
            }
            for (const node of nodesToClear) {
                pdfPageAsString = this.replaceNode(pdfPageAsString, node)
            }
            objectsContext.startModifiedIndirectObject(textObjectID)
            const stream = objectsContext.startUnfilteredPDFStream()
            stream.getWriteStream().write(Array.from(iconv.encode(pdfPageAsString, encoding)))
            objectsContext.endPDFStream(stream)
            objectsContext.endIndirectObject()
            try {
                for (const image of images) {
                    const imageId = pageJSObject.Resources.toJSObject().XObject.toJSObject()[image].getObjectID()
                    objectsContext.startModifiedIndirectObject(imageId)
                    const stream2 = objectsContext.startUnfilteredPDFStream()
                    objectsContext.endPDFStream(stream2)
                    objectsContext.endIndirectObject()
                }
            } catch (err) {
                console.log('ERROR ON REMOVING IMAGE', err)
            }
        }
        modPdfWriter.end()
        return writer.toBuffer()
    }

}

const clearSensitiveData = async (buffer, texts) => {
    const editor = new PdfEditor(buffer, texts)
    await editor.init()
    return await editor.process()
}

const extractTextFromPDFBuffer = async (buffer) => {
    const editor = new PdfEditor(buffer)
    await editor.init()
    return editor.extractText()
}

module.exports = {
    clearSensitiveData,
    extractTextFromPDFBuffer,
    stream2buffer,
    bufferToStream,
}