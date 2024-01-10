const hummus = require('hummus')
const { map, forOwn, mapValues, extend, pickBy } = require('lodash')

const MultiDictHelper = require('./multi-dict-helper')
const PDFInterpreter = require('./pdf-interpreter')

function parseInterestingResources (resourcesDicts, pdfReader, readResources) {
    const forms = {}
    const result = { forms }

    if (resourcesDicts) {
        if (resourcesDicts.exists('XObject')) {
            const xObjects = resourcesDicts.queryDictionaryObject('XObject', pdfReader)
            if (xObjects) {
                const xObjectsJS = xObjects.toJSObject()
                forOwn(xObjectsJS, (xobjectReference, xobjectName)=>{
                    const xobjectObjectId = xobjectReference.toPDFIndirectObjectReference().getObjectID()
                    const xobject = pdfReader.parseNewObject(xobjectObjectId)
                    if (xobject.getType() === hummus.ePDFObjectStream) {
                        const xobjectStream = xobject.toPDFStream()
                        const xobjectDict = xobjectStream.getDictionary()
                        if (xobjectDict.queryObject('Subtype').value === 'Form') {
                            // got a form!
                            forms[xobjectName] = {
                                id:  xobjectObjectId,
                                xobject: xobjectStream,
                                matrix: xobjectDict.exists('Matrix') ? map(pdfReader.queryDictionaryObject(xobjectDict, 'Matrix').toPDFArray().toJSArray(), item=>item.value) : null,
                            }
                        }
                    }            
                })
            }
        }

        if (readResources) {
            readResources(resourcesDicts, pdfReader, result)
        }
    }

    return result
}

function getResourcesDictionary (anObject, pdfReader) {
    return anObject.exists('Resources') ? pdfReader.queryDictionaryObject(anObject, 'Resources').toPDFDictionary() : null
}

function getResourcesDictionaries (anObject, pdfReader) {
    // gets an array of resources dictionaries, going up parents. should
    // grab 1 for forms, and 1 or more for pages
    const resourcesDicts = []
    while (anObject) {
        const dict = getResourcesDictionary(anObject, pdfReader)
        if (dict)
            resourcesDicts.push(dict)

        if (anObject.exists('Parent')) {
            const parentDict = pdfReader.queryDictionaryObject(anObject, 'Parent')
            if (parentDict.getType() === hummus.ePDFObjectDictionary)
                anObject = parentDict.toPDFDictionary()
            else
                anObject = null
        }
        else
            anObject = null
    }
    return new MultiDictHelper(resourcesDicts)
}

function inspectPages (pdfReader, collectPlacements, readResources) {
    const formsUsed = {}
    const pagesPlacements = []
    // iterate pages, fetch placements, and mark forms for later additional inspection
    for (let i = 0; i < pdfReader.getPagesCount(); ++i) {
        const pageDictionary = pdfReader.parsePageDictionary(i)

        const placements = []
        pagesPlacements.push(placements)

        const interpreter = new PDFInterpreter()
        interpreter.interpretPageContents(pdfReader, pageDictionary, collectPlacements(
            parseInterestingResources(getResourcesDictionaries(pageDictionary, pdfReader), pdfReader, readResources),
            placements,
            formsUsed
        ))
    }

    return {
        pagesPlacements,
        formsUsed,
    }
}

function inspectForms (formsToProcess, pdfReader, formsBacklog, collectPlacements, readResources) {
    if (Object.keys(formsToProcess).length === 0)
        return formsBacklog
    // add fresh entries to backlog for the sake of registering the forms as discovered,
    // and to provide structs for filling with placement data
    formsBacklog = extend(formsBacklog, mapValues(formsToProcess, ()=>{return []}))
    const formsUsed = {}
    forOwn(formsToProcess, (form, formId)=> {
        const interpreter = new PDFInterpreter()
        interpreter.interpretXObjectContents(pdfReader, form, collectPlacements(
            parseInterestingResources(getResourcesDictionaries(form.getDictionary(), pdfReader), pdfReader, readResources),
            formsBacklog[formId],
            formsUsed
        ))
    })

    const newUsedForms = pickBy(formsUsed, (form, formId)=> {
        return !formsBacklog[formId]
    })
    // recurse to new forms
    inspectForms(newUsedForms, pdfReader, formsBacklog, collectPlacements, readResources)

    // return final result
    return formsBacklog
}


function extractPlacements (pdfReader, collectPlacements, readResources) {
    const { pagesPlacements, formsUsed } = inspectPages(pdfReader, collectPlacements, readResources)

    const formsPlacements = inspectForms(formsUsed, pdfReader, null, collectPlacements, readResources)
    return {
        pagesPlacements,
        formsPlacements,
    }
}

module.exports = extractPlacements