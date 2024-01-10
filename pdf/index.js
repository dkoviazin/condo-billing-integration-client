const { Duplex } = require('stream')

const hummus = require('hummus')
const iconv = require('iconv-lite')
const jschardet = require('jschardet')
const MemoryStream = require('memory-streams')

const extractText = require('./lib/text-extraction')

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


class PdfEditor {

    constructor (buffer, texts = []) {
        this.buffer = buffer
        this.texts = texts
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
        console.log('Clear data', text)
        return streamContent
            .split(text).join('')
            .split(octalString).join('')
            .split(hexString).join('')
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
            for (const node of nodesToClear) {
                pdfPageAsString = this.replaceNode(pdfPageAsString, node)
            }
            objectsContext.startModifiedIndirectObject(textObjectID)
            const stream = objectsContext.startUnfilteredPDFStream()
            stream.getWriteStream().write(Array.from(iconv.encode(pdfPageAsString, encoding)))
            objectsContext.endPDFStream(stream)
            objectsContext.endIndirectObject()
            try {
                const images = Object.keys(pageJSObject.Resources.toJSObject().XObject.toJSObject())
                for (const image of images) {
                    const imageId = pageJSObject.Resources.toJSObject().XObject.toJSObject()[image].getObjectID()
                    objectsContext.startModifiedIndirectObject(imageId)
                    const stream2 = objectsContext.startUnfilteredPDFStream()
                    objectsContext.endPDFStream(stream2)
                    objectsContext.endIndirectObject()
                }
            } catch (err) {
                console.log('Skipp image remove')
            }
        }
        modPdfWriter.end()
        return writer.toBuffer()
    }

}

const clearSensitiveData = async (buffer, originalName, texts) => {
    const editor = new PdfEditor(buffer, originalName, texts)
    return await editor.process()
}

const extractTextFromPDFStream = async (buffer) => {
    const editor = new PdfEditor(buffer)
    return editor.extractText()
}

module.exports = {
    clearSensitiveData,
    extractTextFromPDFStream,
    stream2buffer,
    bufferToStream,
}