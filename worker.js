// Web Worker для обработки файлов
self.importScripts('https://unpkg.com/dcmjs@0.41.0/build/dcmjs.js', 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');

// Собственная реализация определения VR для тегов
function getVrForTag(tag) {
    const tagDict = dcmjs.data.DicomMetaDictionary.dictionary[tag];
    return tagDict ? tagDict.vr : null;
}

// Функция для обработки чисел в Decimal String (DS)
function formatDS(value) {
    if (typeof value === 'number') {
        // Ограничиваем длину до 16 символов и убираем лишние нули
        return value.toString().substring(0, 16).replace(/(\.\d*?[1-9])0+$/, '$1');
    }
    return value;
}

self.onmessage = async function(e) {
    const { type, data } = e.data;
    
    if (type === 'processSeries') {
        await processSeries(data);
    }
};

async function processSeries({ seriesName, studyInstanceUID, seriesInstanceUID, metadata, dataFiles}) {
    try {
        const zip = new JSZip();
        const seriesFolder = zip.folder(seriesName);
        
        // Обрабатываем каждый файл данных
        for (let i = 0; i < dataFiles.length; i++) {
            const file = dataFiles[i];
            
            try {
                // Читаем файл
                const fileData = await readFileAsArrayBuffer(file);
                
                // Распаковываем gzip
                const decompressedData = await decompressGzip(fileData);
                
                // Создаем DICOM файл
                const dicomBuffer = createDicomFile(
                    decompressedData,
                    {
                        ...metadata,
                        studyInstanceUID,
                        seriesInstanceUID,
                        instanceNumber: parseInt(file.name.replace(seriesName+'_', '')),
                        studyId: seriesName,
                    }
                );
                
                // Добавляем в архив
                const fileName = `${file.name}.dcm`;
                seriesFolder.file(fileName, dicomBuffer);
                
                // Отправляем прогресс
                self.postMessage({
                    type: 'progress',
                    data: {
                        current: i + 1,
                        total: dataFiles.length,
                        seriesName
                    }
                });
                
            } catch (error) {
                console.error(`Ошибка при обработке файла ${file.name}:`, error);
            }
        }
        
        // Генерируем архив
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        
        // Отправляем результат
        self.postMessage({
            type: 'complete',
            data: {
                seriesName,
                zipBlob
            }
        });
        
    } catch (error) {
        self.postMessage({
            type: 'error',
            data: {
                seriesName,
                error: `Ошибка при обработке серии ${seriesName}: ${error.message}`
            }
        });
    }
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Ошибка при чтении файла'));
        
        reader.readAsArrayBuffer(file);
    });
}

// Функция для распаковки gzip (без использования pako)
async function decompressGzip(compressedData) {
    // Используем Compression API, если доступен
    if ('CompressionStream' in self) {
        const stream = new Blob([compressedData]).stream();
        const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
        const decompressedBlob = await new Response(decompressedStream).arrayBuffer();
        return new Uint16Array(decompressedBlob);
    } else {
        // Fallback для браузеров без Compression API
        throw new Error('Decompression API not supported in this browser');
    }
}

function createDicomFile(pixelData, metadata) {
    const { DicomMetaDictionary, DicomDict } = dcmjs.data;

    const slicePosition = metadata.centerZ + (metadata.instanceNumber - metadata.sizeZ / 2.0) * metadata.voxelSizeZ;

    // 1. Денатурализуем данные с явными тегами
    const dataset = {
        // Patient Module
        '00100010': { vr: 'PN', Value: [metadata.patientName || 'Anonymous'] }, // PatientName
        '00100020': { vr: 'LO', Value: [metadata.patientID || ''] }, // PatientID

        // Study Module
        '0020000D': { vr: 'UI', Value: [metadata.studyInstanceUID] }, // StudyInstanceUID
        '00080020': { vr: 'DA', Value: [metadata.studyDate || ''] }, // StudyDate
        '00080030': { vr: 'TM', Value: [metadata.studyTime || ''] }, // StudyTime

        // Series Module
        '0020000E': { vr: 'UI', Value: [metadata.seriesInstanceUID] }, // SeriesInstanceUID
        '00200032': { vr: 'DS', Value: [metadata.centerX.toFixed(4), metadata.centerY.toFixed(4), slicePosition.toFixed(4)] }, // ImagePositionPatient
        '00200037': { vr: 'DS', Value: ['1\\0\\0\\0\\1\\0'] }, // ImageOrientationPatient
        '00201041': { vr: 'DS', Value: [slicePosition.toFixed(4)] }, // SliceLocation
        '00080060': { vr: 'CS', Value: [metadata.modality || 'CT'] }, // Modality

        // Image Module
        '00200013': { vr: 'IS', Value: [metadata.instanceNumber.toString()] }, // InstanceNumber
        '00280010': { vr: 'US', Value: [metadata.sizeY] }, // Rows
        '00280011': { vr: 'US', Value: [metadata.sizeX] }, // Columns
        '00280030': { vr: 'DS', Value: [metadata.voxelSizeX.toString(), metadata.voxelSizeY.toString()] }, // PixelSpacing
        '00180050': { vr: 'DS', Value: [metadata.voxelSizeZ?.toString() || '1.0'] }, // SliceThickness
        '00280004': { vr: 'CS', Value: ['MONOCHROME2'] }, // PhotometricInterpretation
        '00280100': { vr: 'US', Value: [16] }, // BitsAllocated
        '00280101': { vr: 'US', Value: [16] }, // BitsStored
        '00280102': { vr: 'US', Value: [15] }, // HighBit
        '00280103': { vr: 'US', Value: [1] }, // PixelRepresentation (Signed)
        '00281052': { vr: 'DS', Value: [-1024] }, // RescaleIntercept
        '00281053': { vr: 'DS', Value: [1] }, // RescaleSlope

        // Уникальные идентификаторы
        '00080018': { vr: 'UI', Value: [DicomMetaDictionary.uid()] }, // SOPInstanceUID
        '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.2'] }, // SOPClassUID (CT Image Storage)

        // Пиксельные данные
        '7FE00010': { vr: 'OW', Value: [pixelData.buffer] } // PixelData
    };

    // 2. Создаем DICOM-словарь
    const dicomDict = new DicomDict({
        '00020001': { vr: 'OB', Value: [new Uint8Array([0, 1]).buffer] }, // FileMetaInformationVersion
        '00020002': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.2'] }, // MediaStorageSOPClassUID
        '00020003': { vr: 'UI', Value: [DicomMetaDictionary.uid()] }, // MediaStorageSOPInstanceUID
        '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] } // Explicit VR Little Endian
    });
    dicomDict.dict = dataset;

    // 3. Преобразуем в ArrayBuffer
    return dicomDict.write();
}

