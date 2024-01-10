const hummus = require('hummus')

function PDFInterpreter () {

}

function debugStream (pdfReader, contentStream) {
    const readStream = pdfReader.startReadingFromStream(contentStream)
    let result = ''
    while (readStream.notEnded())
    {
        result += String.fromCharCode.apply(String, readStream.read(10000))
    }    
    console.log('-----------------stream content------------------')
    console.log(result)
}

function interpretContentStream (objectParser, onOperatorHandler) {
        
    let operandsStack = []
    let anObject = objectParser.parseNewObject()
    
    while (anObject) {
        if (anObject.getType() === hummus.ePDFObjectSymbol) {
            // operator!
            onOperatorHandler(anObject.value, operandsStack.concat())
            operandsStack = []
        }
        else {
            // operand!
            operandsStack.push(anObject)
        }
        anObject = objectParser.parseNewObject()
    }   
}

PDFInterpreter.prototype.interpretPageContents = function (pdfReader, pageObject, onOperatorHandler) {
    pageObject = pageObject.toPDFDictionary()
    const contents = pageObject.exists('Contents') ? pdfReader.queryDictionaryObject(pageObject, ('Contents')) : null
    if (!contents) {
        return
    }
    if (contents.getType() === hummus.ePDFObjectArray) {
        interpretContentStream(pdfReader.startReadingObjectsFromStreams(contents.toPDFArray()), onOperatorHandler)
    }
    else {
        interpretContentStream(pdfReader.startReadingObjectsFromStream(contents.toPDFStream()), onOperatorHandler)
    }    
}

PDFInterpreter.prototype.interpretXObjectContents = function (pdfReader, xobjectObject, onOperatorHandler) {
    interpretContentStream(pdfReader.startReadingObjectsFromStream(xobjectObject.toPDFStream()), onOperatorHandler)
}

PDFInterpreter.prototype.interpretStream = function (pdfReader, stream, onOperatorHandler) {
    interpretContentStream(pdfReader.startReadingObjectsFromStream(stream), onOperatorHandler)
}

module.exports = PDFInterpreter