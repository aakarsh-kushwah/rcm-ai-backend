const multer = require('multer');

// फ़ाइल को मेमोरी में स्टोर करें ताकि हम उसे सीधे Cloudinary पर भेज सकें
const storage = multer.memoryStorage();

// सिर्फ वीडियो फाइल्स को ही अलाउ करें
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('video')) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type! Please upload only videos.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { 
        fileSize: 100 * 1024 * 1024 // 100 MB फ़ाइल साइज़ लिमिट
    }
});

module.exports = upload;