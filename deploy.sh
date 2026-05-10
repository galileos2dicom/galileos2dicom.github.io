#!/bin/bash

./node_modules/.bin/uglifyjs script.js > script.min.js
./node_modules/.bin/uglifyjs worker.js > worker.min.js

yc storage s3 cp --content-type application/xml sitemap.xml s3://galileos2dicom.ru/
yc storage s3 cp --content-type image/x-icon favicon.ico s3://galileos2dicom.ru/
yc storage s3 cp --content-type text/html index.html s3://galileos2dicom.ru/
yc storage s3 cp --content-type text/css style.css s3://galileos2dicom.ru/
yc storage s3 cp --content-type application/x-javascript dcmjs-0.41.0.min.js s3://galileos2dicom.ru/
yc storage s3 cp --content-type application/x-javascript jszip-3.10.1.min.js s3://galileos2dicom.ru/
yc storage s3 cp --content-type application/x-javascript worker.min.js s3://galileos2dicom.ru/
yc storage s3 cp --content-type application/x-javascript script.min.js s3://galileos2dicom.ru/
