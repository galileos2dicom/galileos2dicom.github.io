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

    const worker = new Worker('worker.js');
    worker.onmessage = function (e) {
        const {type, data} = e.data;

        switch (type) {
            case 'series':
                handleSeriesFound(data.seriesNames);
                break;

            case 'fatal':
                handleError(data.error);
                break;

            case 'progress':
                updateSeriesProgress(data.seriesName, data.current, data.total);
                break;

            case 'complete':
                handleSeriesComplete(data.seriesName, data.zipBlob);
                break;

            case 'error':
                handleError(data.error, data.seriesName);
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
        seriesData[seriesName].total = total;
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

    function processFiles(files) {
        dropArea.classList.remove('error');
        statusDiv.textContent = 'Анализ структуры папки...';

        worker.postMessage({
            type: 'processFiles',
            data: { files }
        });
    }

    function handleSeriesFound(seriesNames) {
        statusDiv.textContent = `Найдено ${seriesNames.length} серий для конвертации.`;

        for (const seriesName of seriesNames) {
            seriesData[seriesName] = {
                ready: false,
                zipBlob: null,
                processed: 0,
                total: 0
            };

            createSeries(seriesName);
        }
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
