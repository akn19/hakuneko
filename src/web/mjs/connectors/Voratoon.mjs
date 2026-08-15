import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class Voratoon extends Connector {

    constructor() {
        super();
        super.id = 'voratoon';
        super.label = 'Voratoon';
        this.tags = ['manga', 'manhwa', 'manhua', 'indonesian'];
        this.url = 'https://v1.voratoon.com';
        this.api = 'https://api.voratoon.com/series/';
        this.requestOptions.headers.set('x-referer', this.url + '/');
        this.requestOptions.headers.set('x-origin', this.url);
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split('/').pop();
        const request = new Request(new URL(slug, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return new Manga(this, data.data.data.slug, data.data.data.title.trim());
    }

    async _getMangas() {
        let mangaList = [];
        for (let page = 1, run = true; run; page++) {
            const mangas = await this._getMangasFromPage(page);
            if (mangas.length === 0) {
                run = false;
            } else {
                mangaList.push(...mangas);
            }
        }
        return mangaList;
    }

    async _getMangasFromPage(page) {
        const request = new Request(new URL(`?take=500&page=${page}`, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return data.data.map(series => {
            return {
                id: series.data.slug,
                title: series.data.title.trim()
            };
        });
    }

    async _getChapters(manga) {
        const request = new Request(new URL(`${manga.id}/chapters`, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return data.data.map(entry => {
            return {
                id: entry.data.index,
                title: [`Chapter ${entry.data.index}`, entry.data.title || ''].join(' ').trim()
            };
        });
    }

    async _getPages(chapter) {
        const request = new Request(new URL(`${chapter.manga.id}/chapters/${chapter.id}`, this.api), this.requestOptions);
        const data = await this.fetchJSON(request);
        return data.data.data.images;
    }
}
