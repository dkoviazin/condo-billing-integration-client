module.exports = {

    transformVector : function (inVector, inMatrix) {
        if (!inMatrix) {
            return inVector
        }
        const fX = inMatrix[0] * inVector[0] + inMatrix[2] * inVector[1] + inMatrix[4]
        const fY = inMatrix[1] * inVector[0] + inMatrix[3] * inVector[1] + inMatrix[5]
        return [fX, fY]
    },
        
    multiplyMatrix: function (inMatrixA, inMatrixB) {
        if (!inMatrixA)
            return inMatrixB
        if (!inMatrixB)
            return inMatrixA
            
        return [
            inMatrixA[0] * inMatrixB[0] + inMatrixA[1] * inMatrixB[2],
            inMatrixA[0] * inMatrixB[1] + inMatrixA[1] * inMatrixB[3],
            inMatrixA[2] * inMatrixB[0] + inMatrixA[3] * inMatrixB[2],
            inMatrixA[2] * inMatrixB[1] + inMatrixA[3] * inMatrixB[3],
            inMatrixA[4] * inMatrixB[0] + inMatrixA[5] * inMatrixB[2] + inMatrixB[4],
            inMatrixA[4] * inMatrixB[1] + inMatrixA[5] * inMatrixB[3] + inMatrixB[5],
        ]
    },
        
    transformBox: function (inBox, inMatrix) {
        if (!inMatrix)
            return inBox
            
        const t = new Array(4)
        t[0] = this.transformVector([inBox[0], inBox[1]], inMatrix)
        t[1] = this.transformVector([inBox[0], inBox[3]], inMatrix)
        t[2] = this.transformVector([inBox[2], inBox[3]], inMatrix)
        t[3] = this.transformVector([inBox[2], inBox[1]], inMatrix)
            
        let minX, minY, maxX, maxY
            
        minX = maxX = t[0][0]
        minY = maxY = t[0][1]
            
        for (let i = 1;i < 4;++i)
        {
            if (minX > t[i][0])
                minX = t[i][0]
            if (maxX < t[i][0])
                maxX = t[i][0]
            if (minY > t[i][1])
                minY = t[i][1]
            if (maxY < t[i][1])
                maxY = t[i][1]
        }
            
        return [minX, minY, maxX, maxY]
    },
        
}
    