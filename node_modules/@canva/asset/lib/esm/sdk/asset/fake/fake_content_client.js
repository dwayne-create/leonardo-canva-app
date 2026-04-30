export class FakeContentClient {
    async upload(options) {
        await Promise.resolve();
        return {
            ref: 'image-id-123',
            whenUploaded: ()=>Promise.resolve()
        };
    }
    async getTemporaryUrl(options) {
        await Promise.resolve();
        return Promise.resolve({
            url: 'https://www.canva.dev/example-assets/image-import/image.jpg',
            ref: 'image-id-123',
            type: 'image'
        });
    }
    async findFonts(options) {
        await Promise.resolve();
        return {
            fonts: [
                aFontWith('Canva Sans'),
                aFontWith('Code Pro'),
                aFontWith('Red Hat Display'),
                aFontWith('Droid Serif')
            ]
        };
    }
    async requestFontSelection(request) {
        await Promise.resolve();
        return {
            type: 'completed',
            font: aFontWith('Canva Sans')
        };
    }
    async openColorSelector(anchor, options) {
        await Promise.resolve();
        return ()=>{};
    }
}
function aFontWith(name) {
    return {
        name,
        ref: `font-id-${name}`,
        weights: [
            {
                weight: 'normal',
                styles: [
                    'normal',
                    'italic'
                ]
            },
            {
                weight: 'bold',
                styles: [
                    'normal'
                ]
            }
        ]
    };
}
