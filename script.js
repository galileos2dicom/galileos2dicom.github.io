document.addEventListener('DOMContentLoaded', () => {
    const dropArea = document.getElementById('dropArea');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const folderInput = document.getElementById('folderInput');
    const statusDiv = document.getElementById('status');
    const seriesListDiv = document.getElementById('seriesList');

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

    // Обработчик переноса файлов/папок
    dropArea.addEventListener('drop', handleDrop, false);

    selectFolderBtn.addEventListener('click', () => {
        folderInput.click();
    });
    // Обработчик выбора папки через кнопку
    folderInput.addEventListener('change', handleFolderSelect, false);

    let seriesData = {};

    const worker = new Worker('worker.min.js');
    worker.onmessage = function (e) {
        const {type, data} = e.data;

        switch (type) {
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
        const {zipBlob} = seriesData[seriesName];
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

    function createSeries(seriesName) {
        const seriesItemID = `series-${seriesName}`;

        if (document.getElementById(seriesItemID)) {
            document.getElementById(seriesItemID).remove();
        }

        const seriesItem = document.createElement('div');
        seriesItem.className = 'series-item';
        seriesItem.id = seriesItemID;
        seriesItem.innerHTML = `
                <div class="series-info">
                    <span>Серия: ${seriesName}</span>
                    <button class="download-btn" id="download-${seriesName}" disabled>
                        Скачать
                    </button>
                </div>
                <div class="progress-container">
                    <div class="progress-bar" id="progress-${seriesName}"></div>
                </div>
                <div id="status-${seriesName}">Ожидание обработки...</div>
            `;
        seriesListDiv.appendChild(seriesItem);
    }

    async function handleFolderSelect(e) {
        const files = e.target.files;
        if (files.length === 0) return;

        await processFiles(Array.from(files));
    }

    async function handleDrop(e) {
        let files = []

        for (let item of e.dataTransfer.items) {
            const entry = item.webkitGetAsEntry();

            if (entry.isDirectory) {
                files.push(...await readDirectory(entry.createReader()));

                continue
            }

            files.push(await getFile(entry));
        }

        if (files.length === 0) return;

        await processFiles(files);
    }

    function getFile(fileEntry) {
        return new Promise((resolve, reject) => {
            fileEntry.file(resolve, reject);
        });
    }

    async function readDirectory(dirReader) {
        let files = [];

        const readBatch = () => {
            return new Promise((resolve, reject) => {
                dirReader.readEntries(resolve, reject); // readEntries возвращает до 100 шт.
            });
        };

        let batch;
        do {
            batch = await readBatch();
            for (let entry of batch) {
                if (entry.isFile) {
                    files.push(await getFile(entry));

                    continue;
                }

                files.push(...await readDirectory(entry.createReader()));
            }
        } while (batch.length > 0); // Продолжаем, пока браузер что-то возвращает

        return files;
    }

    async function processFiles(files) {
        dropArea.classList.remove('error');
        statusDiv.textContent = 'Анализ структуры папки...';

        const gwgFiles = files.filter(f => f.name.endsWith('.gwg'));
        if (gwgFiles.length === 0) {
            handleError('Файл .gwg не найден в выбранной папке');
            return;
        }

        const studySeriesRegExps = gwgFiles.map((gwgFile, i, arr) => {
            return new RegExp(gwgFile.name.replace('.gwg', '') + '_vol_[0-9]+$', 'i')
        });

        const metadataFiles = files.filter((f, i, arr) => {
            for (const studySeriesRegEx of studySeriesRegExps) {
                if (studySeriesRegEx.test(f.name)) {
                    return true
                }
            }

            return false;
        });

        if (metadataFiles.length === 0) {
            handleError('Мета-файлы серий не найдены');
            return;
        }

        statusDiv.textContent = `Найдено ${metadataFiles.length} серий для конвертации.`;

        for (const metadataFile of metadataFiles) {
            const seriesName = metadataFile.name;
            seriesData[seriesName] = {
                ready: false,
                zipBlob: null,
                processed: 0,
                total: 0
            };

            createSeries(seriesName);

            try {
                updateSeriesStatus(seriesName, `Обработка серии ${seriesName}...`);

                const metadata = await parseMetadataFile(metadataFile);

                const sliceFiles = files.filter(f =>
                    f.name.startsWith(`${seriesName}_`)
                );
                seriesData[seriesName].total = sliceFiles.length;

                if (sliceFiles.length === 0) {
                    throw new Error(`Слайсы для серии ${seriesName} не найдены`);
                }

                updateSeriesStatus(seriesName, `Найдено ${sliceFiles.length} слайсов в серии ${seriesName}`);

                worker.postMessage({
                    type: 'processSeries',
                    data: {
                        seriesName: seriesName,
                        metadata,
                        sliceFiles: sliceFiles,
                    }
                });

            } catch (error) {
                console.error(seriesName, error)
                handleError(error.message, seriesName);
            }
        }
    }

    async function parseMetadataFile(file) {
        return new Promise(async (resolve, reject) => {
            const reader = new FileReader();

            reader.onload = async (e) => {
                try {
                    const compressedData = new Uint8Array(e.target.result);
                    const decompressedData = await decompressGzip(compressedData);

                    const xmlText = new TextDecoder().decode(decompressedData);
                    const parser = new DOMParser();
                    const xmlDoc = parser.parseFromString(xmlText, "application/xml");

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

    async function decompressGzip(compressedData) {
        if ('CompressionStream' in window) {
            const stream = new Blob([compressedData]).stream();
            const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
            const decompressedBlob = await new Response(decompressedStream).arrayBuffer();
            return new Uint8Array(decompressedBlob);
        }

        throw new Error('Decompression API not supported in this browser');
    }

    function handleError(errorMessage, seriesName = null) {
        console.error(errorMessage);

        if (seriesName) { // Если ошибка относится к конкретной серии
            updateSeriesStatus(seriesName, `Ошибка: ${errorMessage}`);
            const progress = document.getElementById(`progress-${seriesName}`);
            if (progress) progress.style.backgroundColor = '#ff6b6b';

            return;
        }

        // Общая ошибка
        statusDiv.innerHTML = `<div class="error-message">${errorMessage}</div>`;
        seriesListDiv.innerHTML = '';
        seriesData = {};
        dropArea.classList.add('error');
    }
});
