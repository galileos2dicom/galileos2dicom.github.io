use galileos2dicom::dicom::convert_slice;
use galileos2dicom::uid::UidGenerator;
use galileos2dicom::volume::{VolumeInfo, is_metadata_file_name};
use std::io::{Cursor, Write};
use wasm_bindgen::prelude::*;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Мета-файл серии: `<hex>_vol_<N>`.
#[wasm_bindgen(js_name = isMetadataFileName)]
pub fn is_metadata_file_name_js(name: &str) -> bool {
    is_metadata_file_name(name)
}

/// Конвертер исследования: один генератор UID на все серии,
/// чтобы UID серий не совпадали.
#[wasm_bindgen]
pub struct Converter {
    uids: UidGenerator,
}

#[wasm_bindgen]
impl Converter {
    /// `unix_ms` — `Date.now()`: в `wasm32-unknown-unknown` нет системного времени.
    #[wasm_bindgen(constructor)]
    pub fn new(unix_ms: f64) -> Converter {
        Converter {
            uids: UidGenerator::new(unix_ms as u64),
        }
    }

    /// Разбирает мета-файл серии (gzip с XML) и открывает для неё zip-архив.
    #[wasm_bindgen(js_name = openSeries)]
    pub fn open_series(&mut self, series_name: &str, meta_gz: &[u8]) -> Result<Series, JsError> {
        let volume_info = VolumeInfo::from_meta_bytes(series_name, meta_gz, &mut self.uids)?;

        Ok(Series {
            volume_info,
            zip: ZipWriter::new(Cursor::new(Vec::new())),
        })
    }
}

/// Серия, слайсы которой складываются в zip как `<series>/<slice>.dcm`.
#[wasm_bindgen]
pub struct Series {
    volume_info: VolumeInfo,
    zip: ZipWriter<Cursor<Vec<u8>>>,
}

#[wasm_bindgen]
impl Series {
    #[wasm_bindgen(js_name = isSliceFileName)]
    pub fn is_slice_file_name(&self, name: &str) -> bool {
        self.volume_info.is_slice_file_name(name)
    }

    /// Конвертирует слайс (gzip с сырыми вокселями) в DICOM и добавляет в архив.
    #[wasm_bindgen(js_name = addSlice)]
    pub fn add_slice(&mut self, slice_name: &str, gz_slice: &[u8]) -> Result<(), JsError> {
        let (name, dicom) = convert_slice(&self.volume_info, slice_name, gz_slice)?;

        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        self.zip.start_file(
            format!("{}/{}", self.volume_info.series_name, name),
            options,
        )?;
        self.zip.write_all(&dicom)?;

        Ok(())
    }

    /// Закрывает архив и возвращает его байты. Объект после вызова уничтожается.
    pub fn finish(self) -> Result<Vec<u8>, JsError> {
        Ok(self.zip.finish()?.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Read;
    use zip::ZipArchive;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn packs_slices_into_zip() {
        let meta = gzip(
            b"<FBPParams><LibParams>\
              <VolSizeX>2</VolSizeX><VolSizeY>2</VolSizeY><VolSizeZ>1</VolSizeZ>\
              </LibParams></FBPParams>",
        );
        let mut series = Converter::new(1_700_000_000_000.0)
            .open_series("ab12_vol_0", &meta)
            .unwrap();

        assert!(series.is_slice_file_name("ab12_vol_0_1"));
        assert!(!series.is_slice_file_name("ab12_vol_1_1"));

        series
            .add_slice("ab12_vol_0_1", &gzip(&[1, 0, 2, 0, 3, 0, 4, 0]))
            .unwrap();

        let mut archive = ZipArchive::new(Cursor::new(series.finish().unwrap())).unwrap();
        assert_eq!(archive.len(), 1);

        let mut dicom = Vec::new();
        archive
            .by_name("ab12_vol_0/ab12_vol_0_1.dcm")
            .unwrap()
            .read_to_end(&mut dicom)
            .unwrap();
        assert_eq!(&dicom[128..132], b"DICM");
        assert!(dicom.ends_with(&[1, 0, 2, 0, 3, 0, 4, 0]));
    }
}
