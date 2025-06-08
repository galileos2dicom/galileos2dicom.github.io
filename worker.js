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
    const totalFiles = dataFiles.length;
    try {
        const zip = new JSZip();
        const seriesFolder = zip.folder(seriesName);
        
        // Обрабатываем каждый файл данных
        for (let i = 0; i < totalFiles; i++) {
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
                        instanceNumber: i + 1
                    }
                );
                
                // Добавляем в архив
                const fileName = `${seriesName}_${i}.dcm`;
                seriesFolder.file(fileName, dicomBuffer);
                
                // Отправляем прогресс
                self.postMessage({
                    type: 'progress',
                    data: {
                        current: i + 1,
                        total: totalFiles,
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
            data: `Ошибка при обработке серии ${seriesName}: ${error.message}`
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

async function decompressGzip(compressedData) {
    // Используем Compression API, если доступен
    if ('CompressionStream' in self) {
        const stream = new Blob([compressedData]).stream();
        const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
        const decompressedBlob = await new Response(decompressedStream).arrayBuffer();
        return new Uint8Array(decompressedBlob);
    } else {
        throw new Error('Decompression API not supported in this browser');
    }
}

function createDicomFile(pixelData, metadata) {
    const { DicomMetaDictionary, DicomDict } = dcmjs.data;
    
    // 1. Создаем натурализованный dataset
    const naturalized = {
        // Patient Module
        PatientName: metadata.patientName || 'Anonymous',
        PatientID: metadata.patientID || '',
        
        // Study Module
        StudyInstanceUID: metadata.studyInstanceUID,
        StudyDate: metadata.studyDate || '',
        StudyTime: metadata.studyTime || '',
        
        // Series Module
        SeriesInstanceUID: metadata.seriesInstanceUID,
        Modality: metadata.modality || 'CT',
        SeriesDescription: metadata.seriesDescription || '',
        
        // Image Module
        InstanceNumber: (metadata.instanceNumber || 1).toString(),
        Rows: metadata.rows || 512,
        Columns: metadata.columns || 512,
        PixelSpacing: metadata.pixelSpacing || [1, 1],
        SliceThickness: metadata.sliceThickness || 1,
        SamplesPerPixel: 1,
        PhotometricInterpretation: 'MONOCHROME2',
        BitsAllocated: 16,
        BitsStored: 16,
        HighBit: 15,
        PixelRepresentation: 1, // signed
        RescaleIntercept: 0,
        RescaleSlope: 1,
        
        // Уникальные идентификаторы
        SOPInstanceUID: DicomMetaDictionary.uid(),
        SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', // CT Image Storage
        
        // Пиксельные данные
        PixelData: new Uint16Array(pixelData)
    };

    // 2. Создаем DICOM словарь
    const dicomDict = new DicomDict(naturalized);
    
    // 3. Устанавливаем Transfer Syntax
    dicomDict.meta = {
        '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] } // Explicit VR Little Endian
    };
    
    // 4. Преобразуем в ArrayBuffer
    return dicomDict.write();
}
