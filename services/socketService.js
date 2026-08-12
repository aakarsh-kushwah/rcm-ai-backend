/**
 * @file services/socketService.js
 * @description Manages Socket.IO instance and emits events for real-time communication.
 */

let io;

const setIoInstance = (ioInstance) => {
    io = ioInstance;
};

const emitProgress = (event, data) => {
    if (io) {
        io.emit(event, data);
    } else {
        console.warn("Socket.IO not initialized. Cannot emit progress.", event, data);
    }
};

module.exports = { setIoInstance, emitProgress };