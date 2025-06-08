// Основной поток обработки
document.addEventListener('DOMContentLoaded', () => {
    const dropArea = document.getElementById('dropArea');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const folderInput = document.getElementById('folderInput');
    const statusDiv = document.getElementById('status');
    const progressDiv = document.getElementById('progress');
    const seriesListDiv = document.getElementById('seriesList');
    
    // Создаем Web Worker
    const worker = new Worker('worker.js');
    let seriesData = {};
    
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

    // Обработчик сообщений от Worker
    worker.onmessage = function(e) {
        const { type, data } = e.data;
        
        switch(type) {
            case 'progress':
                updateSeriesProgress(data.seriesName, data.current, data.total);
                break;
                
            case 'complete':
                handleSeriesComplete(data.seriesName, data.zipBlob);
                break;
                
            case 'error':
                updateSeriesStatus(data.seriesName, `Ошибка: ${data.error}`);
                break;
                
            case 'status':
                updateSeriesStatus(data.seriesName, data.message);
                break;
        }
    };

    function updateSeriesProgress(seriesName, current, total) {
        const progress = document.getElementById(`progress-${seriesName}`);
        const percentage = Math.round((current / total) * 100);
        progress.style.width = `${percentage}%`;
        
        seriesData[seriesName].processed = current;
        updateSeriesStatus(seriesName, `Обработано ${current} из ${total} файлов`);
    }

    function handleSeriesComplete(seriesName, zipBlob) {
        seriesData[seriesName].ready = true;
        seriesData[seriesName].zipBlob = zipBlob;
        
        const btn = document.getElementById(`download-${seriesName}`);
        btn.disabled = false;
        btn.onclick = () => downloadSeries(seriesName);
        
        updateSeriesStatus(seriesName, 'Готово к скачиванию');
    }

    function updateSeriesStatus(seriesName, message) {
        const status = document.getElementById(`status-${seriesName}`);
        if (status) status.textContent = message;
    }

    function downloadSeries(seriesName) {
        const { zipBlob } = seriesData[seriesName];
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${seriesName}.zip`;
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }
    
    async function handleDrop(e) {
        const items = e.dataTransfer.items;
        await processItems(items);
    }

    async function handleFolderSelect(e) {
        const files = e.target.files; // Переименовано в files вместо fileList
        if (files.length === 0) return;
        
        await processFiles(files); // Передаём files вместо fileList
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
            await processFiles(files);
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
    
    async function processFiles(fileList) {
        statusDiv.textContent = 'Анализ структуры папки...';
        seriesListDiv.innerHTML = '';
        
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

        statusDiv.textContent = `Найдено ${volMetaFiles.size} серий для конвертации`;
    
        // Генерируем UID для исследования
        const studyInstanceUID = dcmjs.data.DicomMetaDictionary.uid();
    
        // 3. Для каждой папки с серией
        for (const volMetaFile of volMetaFiles) {
            seriesData[volMetaFile] = {
                ready: false,
                zipBlob: null,
                processed: 0,
                total: 0
            };
            // Создаем элемент для серии
            const seriesItem = document.createElement('div');
            seriesItem.className = 'series-item';
            seriesItem.id = `series-${volMetaFile}`;
            seriesItem.innerHTML = `
                <div class="series-info">
                    <span>Серия: ${volMetaFile}</span>
                    <button class="download-btn" id="download-${volMetaFile}" disabled>
                        Скачать
                    </button>
                </div>
                <div class="progress-container">
                    <div class="progress-bar" id="progress-${volMetaFile}"></div>
                </div>
                <div id="status-${volMetaFile}">Ожидание обработки...</div>
            `;
            seriesListDiv.appendChild(seriesItem);

            const seriesInstanceUID = dcmjs.data.DicomMetaDictionary.uid();
            try {
                updateSeriesStatus(volMetaFile, `Обработка серии ${volMetaFile}...`);
            
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
                seriesData[volMetaFile].total = seriesFiles.length;
            
                if (volDataFiles.length === 0) {
                    throw new Error(`Файлы с данными не найдены для серии ${volMetaFile}`);
                }
            
                updateSeriesStatus(volMetaFile, `Найдено ${volDataFiles.length} файлов данных в серии ${volMetaFile}`);
            
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
                handleError(`Ошибка при обработке серии: ${error.message}`, volMetaFile);
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
                    const xmlDoc = parser.parseFromString(xmlText, "application/xml");
                    
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
    
    function extractMetadataFromXML(doc) {
        const root = doc.documentElement;

        if (!root || root.nodeName !== 'FBPParams') {
            throw new Error('Неверный формат XML: ожидался FBPParams');
        }

        // Поиск узла LibParams
        const libParams = Array.from(root.children).find(node => node.nodeName === 'LibParams');
        if (!libParams) {
            throw new Error('Не найден узел LibParams');
        }

        // Извлечение метаданных и привязка к DICOM-полям
        const metadata = {};
        for (let node of libParams.children) {
            const nodeName = node.nodeName;
            const content = node.textContent.trim();

            switch (nodeName) {
                case 'ScanParamsXml':
                    metadata.scanParamsXml = content;

                    // Парсинг вложенного XML
                    const scanParser = new DOMParser();
                    const scanDoc = scanParser.parseFromString(content, 'application/xml');
                    const imageDesc = scanDoc.querySelector('IMAGEDESCRIPTION');

                    if (imageDesc) {
                        const deviceNode = imageDesc.querySelector('DEVICE');
                        const imageNode = imageDesc.querySelector('IMAGE');

                        if (deviceNode) {
                            metadata.deviceId = deviceNode.getAttribute('deviceid');
                            metadata.hwVersion = deviceNode.getAttribute('hwversion');
                            metadata.swVersion = deviceNode.getAttribute('swversion');
                        }

                        if (imageNode) {
                            metadata.kvp = imageNode.getAttribute('kv'); // КВП напряжение
                            metadata.ma = imageNode.getAttribute('ma'); // Миллиампер 
                            metadata.pixelSize = parseFloat(imageNode.getAttribute('pixelsize')) / 100; // Размер пикселя в мм
                            metadata.studyDate = imageNode.getAttribute('takedate').replace(/-/g, ''); // DICOM StudyDate
                            metadata.studyTime = imageNode.getAttribute('taketime').replace(/:/g, ''); // DICOM StudyTime
                            metadata.imageType = imageNode.getAttribute('imagetype');
                            metadata.sensorType = imageNode.getAttribute('sensortype');
                        }
                    }
                    break;
                case 'SequenceID':
                    metadata.sequenceID = content;
                    break;
                case 'TimeStamp':
                    metadata.studyDate = content.slice(0, 8); // YYYYMMDD
                    metadata.studyTime = content.slice(8); // HHMMSS
                    break;
                case 'ScanID':
                    metadata.studyInstanceUID = content;
                    break;
                case 'VolSizeX':
                    metadata.sizeX = parseInt(content);
                    break;
                case 'VolSizeY':
                    metadata.sizeY = parseInt(content);
                    break;
                case 'VolSizeZ':
                    metadata.sizeZ = parseInt(content);
                    break;
                case 'VoxelSizeX':
                    metadata.voxelSizeX = parseFloat(content);
                    break;
                case 'VoxelSizeY':
                    metadata.voxelSizeY = parseFloat(content);
                    break;
                case 'VoxelSizeZ':
                    metadata.voxelSizeZ = parseFloat(content);
                    break;
                case 'CenterX':
                    metadata.centerX = parseFloat(content);
                    break;
                case 'CenterY':
                    metadata.centerY = parseFloat(content);
                    break;
                case 'CenterZ':
                    metadata.centerZ = parseFloat(content);
                    break;
                case 'VoxelValueMin':
                    metadata.minValue = parseInt(content);
                    break;
                case 'VoxelValueMax':
                    metadata.maxValue = parseInt(content);
                    break;
            }
        }

        return metadata;
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

    function handleError(errorMessage, seriesName = null) {
        console.error(errorMessage);
        
        if (seriesName) {
            // Если ошибка относится к конкретной серии
            updateSeriesStatus(seriesName, `Ошибка: ${errorMessage}`);
            const progress = document.getElementById(`progress-${seriesName}`);
            if (progress) progress.style.backgroundColor = '#ff6b6b';
        } else {
            // Общая ошибка
            statusDiv.innerHTML = `<div class="error-message">${errorMessage}</div>`;
            
            // Очищаем список серий при общей ошибке
            seriesListDiv.innerHTML = '';
            
            // Показываем кнопку "Попробовать снова"
            const retryBtn = document.createElement('button');
            retryBtn.textContent = 'Попробовать снова';
            retryBtn.className = 'retry-btn';
            retryBtn.onclick = () => {
                statusDiv.textContent = '';
                dropArea.classList.remove('error');
                retryBtn.remove();
            };
            
            statusDiv.appendChild(retryBtn);
            dropArea.classList.add('error');
        }
    }
});
