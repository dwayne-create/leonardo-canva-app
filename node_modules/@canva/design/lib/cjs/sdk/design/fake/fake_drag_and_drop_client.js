"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "FakeDragAndDropClient", {
    enumerable: true,
    get: function() {
        return FakeDragAndDropClient;
    }
});
class FakeDragAndDropClient {
    async startDrag(event, dragData) {
        await this.delay();
    }
    async startDragToPoint(event, dragData) {
        await this.delay();
    }
    async startDragToCursor(event, dragData) {
        await this.delay();
    }
    constructor(delay){
        this.delay = delay;
    }
}
