// Основной поток обработки
document.addEventListener('DOMContentLoaded', () => {
    const dropArea = document.getElementById('dropArea');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const folderInput = document.getElementById('folderInput');
    const statusDiv = document.getElementById('status');
    const progressDiv = document.getElementById('progress');
    
    // Создаем Web Worker
    const worker = new Worker('worker.js');
    
    // Обработчики для drag and drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, highlight, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, unhighlight, false);
    });
    
    function highlight() {
        dropArea.classList.add('highlight');
    }
    
    function unhighlight() {
        dropArea.classList.remove('highlight');
    }
    
    dropArea.addEventListener('drop', handleDrop, false);
    
    // Обработчик выбора папки через кнопку
    selectFolderBtn.addEventListener('click', () => {
        folderInput.click();
    });
    
    folderInput.addEventListener('change', handleFolderSelect, false);
    
    // Обработка событий от Web Worker
    worker.onmessage = function(e) {
        const { type, data } = e.data;
        
        switch(type) {
            case 'progress':
                updateProgress(data);
                break;
            case 'status':
                updateStatus(data);
                break;
            case 'complete':
                handleConversionComplete(data);
                break;
            case 'error':
                handleError(data);
                break;
        }
    };
    
    function updateStatus(message) {
        statusDiv.textContent = message;
    }
    
    function updateProgress({ current, total }) {
        const percentage = Math.round((current / total) * 100);
        progressDiv.innerHTML = `<div class="progress-bar" style="width: ${percentage}%"></div>`;
    }
    
    function handleError(error) {
        statusDiv.textContent = `Ошибка: ${error}`;
        console.error(error);
    }
    
    function handleConversionComplete({ seriesName, zipBlob }) {
        statusDiv.textContent = `Конвертация завершена для серии ${seriesName}`;
        
        // Создаем ссылку для скачивания
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${seriesName}.zip`;
        document.body.appendChild(a);
        a.click();
        
        // Очистка
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 0);
    }
    
    async function handleDrop(e) {
        const items = e.dataTransfer.items;
        await processItems(items);
    }

    async function handleFolderSelect(e) {
        const files = e.target.files; // Переименовано в files вместо fileList
        if (files.length === 0) return;
        
        // Получаем папку из первого файла
        const folderPath = files[0].webkitRelativePath.split('/')[0];
        await processFiles(files, folderPath); // Передаём files вместо fileList
    } 
    
    async function processItems(items) {
        const entries = [];
        
        for (let item of items) {
            const entry = item.webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
        
        if (entries.length === 0) return;
        
        // Обрабатываем только первую папку (если их несколько)
        if (entries[0].isDirectory) {
            const dirReader = entries[0].createReader();
            const files = await readDirectory(dirReader);
            await processFiles(files, entries[0].name);
        }
    }
    
    function readDirectory(dirReader) {
        return new Promise((resolve) => {
            dirReader.readEntries(async (entries) => {
                const files = [];
                
                for (let entry of entries) {
                    if (entry.isFile) {
                        const file = await getFile(entry);
                        files.push(file);
                    }
                }
                
                resolve(files);
            });
        });
    }
    
    function getFile(fileEntry) {
        return new Promise((resolve) => {
            fileEntry.file(resolve);
        });
    }
    
    async function processFiles(fileList, folderPath) {
        updateStatus('Анализ структуры папки...');
        
        // Преобразуем FileList в массив
        const allFiles = Array.from(fileList);
        
        // 1. Находим файл .gwg
        const gwgFile = allFiles.find(f => f.name.endsWith('.gwg'));
        if (!gwgFile) {
            handleError('Файл .gwg не найден в выбранной папке');
            return;
        }
        
        const studyName = gwgFile.name.replace('.gwg', '');
        const studySeriesRegEx = new RegExp(studyName + '_vol_[0-9]+$', 'i');
        
        // 2. Находим мета-файлы с префиксом _vol_*
        const volMetaFiles = new Set();
        allFiles.forEach(f => {
            if (studySeriesRegEx.test(f.webkitRelativePath)) {
                const parts = f.webkitRelativePath.split('/');
                volMetaFiles.add(parts[parts.length-1]);
            }
        });
        
        if (volMetaFiles.size === 0) {
            handleError('Папки с сериями (_vol_*) не найдены');
            return;
        }
 
        updateStatus(`Найдено ${volMetaFiles.size} серий для конвертации`);
    
        // Генерируем UID для исследования
        const studyInstanceUID = dcmjs.data.DicomMetaDictionary.uid();
    
        // 3. Для каждой папки с серией
        for (const volMetaFile of volMetaFiles) {
            const seriesInstanceUID = dcmjs.data.DicomMetaDictionary.uid();
            try {
                updateStatus(`Обработка серии ${volMetaFile}...`);
            
                const zip = new JSZip();
                const seriesFolder = zip.folder(volMetaFile);
                const seriesFiles = allFiles.filter(f => 
                    f.name.startsWith(volMetaFile)
                );
            
                // Находим файл с метаданными (название как у папки)
                const metadataFile = seriesFiles.find(f => 
                    f.name === volMetaFile
                );
            
                if (!metadataFile) {
                    throw new Error(`Файл метаданных не найден для серии ${volMetaFile}`);
                }
            
                // Читаем и парсим метаданные
                const metadata = await parseMetadataFile(metadataFile);
            
                // Находим файлы с данными (префикс _vol_*_*)
                const volDataFiles = seriesFiles.filter(f => 
                    f.name.startsWith(`${volMetaFile}_`)
                );
            
                if (volDataFiles.length === 0) {
                    throw new Error(`Файлы с данными не найдены для серии ${volMetaFile}`);
                }
            
                updateStatus(`Найдено ${volDataFiles.length} файлов данных в серии ${volMetaFile}`);
            
                worker.postMessage({
                    type: 'processSeries',
                    data: {
                        seriesName: volMetaFile,
                        studyInstanceUID,
                        seriesInstanceUID,
                        metadata,
                        dataFiles: volDataFiles,
                    }
                });
            
            } catch (error) {
                handleError(`Ошибка при обработке серии ${volMetaFile}: ${error.message}`);
            }
        }
    }
 
    async function parseMetadataFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = async (e) => {
                try {
                    // 4.2.1.1. Распаковываем gzip
                    const compressedData = new Uint8Array(e.target.result);
                    const decompressedData = await decompressGzip(compressedData);
                    
                    // 4.2.1.2. Парсим XML
                    const xmlText = new TextDecoder().decode(decompressedData);
                    const parser = new DOMParser();
                    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
                    
                    // Извлекаем нужные метаданные из XML
                    const metadata = extractMetadataFromXML(xmlDoc);
                    resolve(metadata);
                    
                } catch (error) {
                    reject(new Error(`Ошибка при парсинге файла метаданных: ${error.message}`));
                }
            };
            
            reader.onerror = () => {
                reject(new Error('Ошибка при чтении файла метаданных'));
            };
            
            reader.readAsArrayBuffer(file);
        });
    }
    
    function extractMetadataFromXML(xmlDoc) {
        // Здесь нужно извлечь все необходимые метаданные из XML
        // Это пример - адаптируйте под реальную структуру вашего XML
        
        const metadata = {
            patientName: getXmlValue(xmlDoc, 'PatientName') || 'Unknown',
            patientID: getXmlValue(xmlDoc, 'PatientID') || '',
            studyDate: getXmlValue(xmlDoc, 'StudyDate') || '',
            studyTime: getXmlValue(xmlDoc, 'StudyTime') || '',
            modality: getXmlValue(xmlDoc, 'Modality') || 'CT',
            seriesDescription: getXmlValue(xmlDoc, 'SeriesDescription') || '',
            rows: parseInt(getXmlValue(xmlDoc, 'Rows') || '0'),
            columns: parseInt(getXmlValue(xmlDoc, 'Columns') || '0'),
            pixelSpacing: getXmlValue(xmlDoc, 'PixelSpacing') || '1\\1',
            sliceThickness: getXmlValue(xmlDoc, 'SliceThickness') || '1',
            // Добавьте другие необходимые поля
        };
        
        return metadata;
    }
    
    function getXmlValue(xmlDoc, tagName) {
        const node = xmlDoc.getElementsByTagName(tagName)[0];
        return node ? node.textContent : null;
    }
    
    // Функция для распаковки gzip (без использования pako)
    async function decompressGzip(compressedData) {
        // Используем Compression API, если доступен
        if ('CompressionStream' in window) {
            const stream = new Blob([compressedData]).stream();
            const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
            const decompressedBlob = await new Response(decompressedStream).arrayBuffer();
            return new Uint8Array(decompressedBlob);
        } else {
            // Fallback для браузеров без Compression API
            throw new Error('Decompression API not supported in this browser');
        }
    }
});
