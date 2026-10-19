// Web Worker для обработки файлов: разбор, конвертация в DICOM и упаковка в zip — в wasm
self.importScripts('pkg/galileos2dicom_web.js');

const { Converter, isMetadataFileName } = wasm_bindgen;
const wasmReady = wasm_bindgen({ module_or_path: 'pkg/galileos2dicom_web_bg.wasm' });

self.onmessage = async function(e) {
    const { type, data } = e.data;

    if (type === 'processFiles') {
        await wasmReady;
        await processFiles(data.files);
    }
};

async function processFiles(files) {
    const metadataFiles = files.filter(f => isMetadataFileName(f.name));

    if (metadataFiles.length === 0) {
        self.postMessage({ type: 'fatal', data: { error: 'Мета-файлы серий не найдены' } });
        return;
    }

    self.postMessage({
        type: 'series',
        data: { seriesNames: metadataFiles.map(f => f.name) }
    });

    // Один конвертер на исследование — UID серий не повторяются
    const converter = new Converter(Date.now());
    try {
        for (const metadataFile of metadataFiles) {
            await processSeries(converter, metadataFile, files);
        }
    } finally {
        converter.free();
    }
}

async function processSeries(converter, metadataFile, files) {
    const seriesName = metadataFile.name;
    let series = null;

    try {
        postStatus(seriesName, `Обработка серии ${seriesName}...`);

        try {
            series = converter.openSeries(seriesName, await readFile(metadataFile));
        } catch (error) {
            throw new Error(`Ошибка при парсинге файла метаданных: ${error.message}`);
        }

        const sliceFiles = files.filter(f => series.isSliceFileName(f.name));
        if (sliceFiles.length === 0) {
            throw new Error(`Слайсы для серии ${seriesName} не найдены`);
        }

        postStatus(seriesName, `Найдено ${sliceFiles.length} слайсов в серии ${seriesName}`);

        let i = 0;
        for (const file of sliceFiles) {
            try {
                series.addSlice(file.name, await readFile(file));
            } catch (error) {
                console.error(`Ошибка при обработке файла ${file.name}:`, error);
            }

            self.postMessage({
                type: 'progress',
                data: {
                    current: ++i,
                    total: sliceFiles.length,
                    seriesName
                }
            });
        }

        postStatus(seriesName, 'Создание архива...');

        // finish() уничтожает объект серии в wasm
        const zipBytes = series.finish();
        series = null;

        self.postMessage({
            type: 'complete',
            data: {
                seriesName,
                zipBlob: new Blob([zipBytes], { type: 'application/zip' })
            }
        });
    } catch (error) {
        console.error(seriesName, error);
        self.postMessage({
            type: 'error',
            data: {
                seriesName,
                error: error.message,
            }
        });
    } finally {
        series?.free();
    }
}

function postStatus(seriesName, message) {
    self.postMessage({ type: 'status', data: { seriesName, message } });
}

async function readFile(file) {
    try {
        return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
        throw new Error(`Ошибка при чтении файла ${file.name}`);
    }
}
