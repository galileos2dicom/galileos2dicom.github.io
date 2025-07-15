#!/bin/bash

./node_modules/.bin/uglifyjs script.js > script.min.js
./node_modules/.bin/uglifyjs worker.js > worker.min.js

mc cp {dcmjs-0.41.0.min.js,jszip-3.10.1.min.js,style.css,worker.min.js,index.html,script.min.js,favicon.ico,sitemap.xml} kulaginds/galileos2dicom.ru
