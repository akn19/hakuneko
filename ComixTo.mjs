import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class ComixTo extends Connector {

    constructor() {
        super();
        super.id = 'comixto';
        super.label = 'Comix (.to)';
        this.tags = [ 'manga', 'manhwa', 'manhua', 'english' ];
        this.url = 'https://comix.to';
        this.apiUrl = this.url + '/api/v2/';
    }

    canHandleURI(uri) {
        return /^https?:\/\/comix\.to/.test(uri.href);
    }

    async _getMangaFromURI(uri) {
        const request = new Request(uri, this.requestOptions);
        const data = await this.fetchDOM(request, 'section.comic-info h1.title');
        const title = data[0].textContent.trim();
        const id = uri.pathname;
        return new Manga(this, id, title);
    }

    async _getMangas() {
        const mangaList = [];
        for (let page = 1, run = true; run; page++) {
            const uri = new URL('./manga?limit=100&page=' + page, this.apiUrl);
            const request = new Request(uri, this.requestOptions);
            const data = await this.fetchJSON(request);
            const items = data.result && data.result.items ? data.result.items : [];
            const mangas = items.map(item => {
                return {
                    id: '/title/' + item.hash_id + '-' + item.slug,
                    title: item.title
                };
            });
            if (mangas.length > 0) {
                mangaList.push(...mangas);
            } else {
                run = false;
            }
        }
        return mangaList;
    }

    async _getChapters(manga) {
        const mangaHash = manga.id.match(/\/title\/([^/-]+)-/).pop();
        const requestHash = ComixHash.GenerateHash('/manga/' + mangaHash + '/chapters');
        const chapterList = [];
        for (let page = 1, run = true; run; page++) {
            const uri = new URL('./manga/' + mangaHash + '/chapters?limit=100&page=' + page + '&order[number]=desc&time=1&_=' + requestHash, this.apiUrl);
            const request = new Request(uri, this.requestOptions);
            const data = await this.fetchJSON(request);
            const items = data.result && data.result.items ? data.result.items : [];
            const chapters = items.map(item => {
                const parts = [ item.number ];
                if (item.name) {
                    parts.push('- ' + item.name);
                }
                if (item.scanlation_group) {
                    parts.push('[' + item.scanlation_group.name + ']');
                }
                return {
                    id: manga.id + '/' + item.chapter_id + '-chapter-' + item.number,
                    title: parts.join(' ')
                };
            });
            if (chapters.length > 0) {
                chapterList.push(...chapters);
            } else {
                run = false;
            }
        }
        return chapterList;
    }

    async _getPages(chapter) {
        const uri = new URL(chapter.id, this.url);
        const request = new Request(uri, this.requestOptions);
        const script = `
            new Promise((resolve, reject) => {
                const check = () => {
                    if (window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps && window.__NEXT_DATA__.props.pageProps.images) {
                        return resolve(window.__NEXT_DATA__.props.pageProps);
                    }
                    for (const key in window) {
                        try {
                            const obj = window[key];
                            if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.images && Array.isArray(obj.images)) {
                                return resolve(obj);
                            }
                        } catch(e) {}
                    }
                    setTimeout(check, 100);
                };
                check();
            })
        `;
        const data = await Engine.Request.fetchUI(request, script, 25000, true);
        return data.images.map(image => this.createConnectorURI({ url: image.url, referer: this.url }));
    }

    async _handleConnectorURI(payload) {
        const request = new Request(payload.url, this.requestOptions);
        request.headers.set('x-referer', payload.referer);
        const response = await fetch(request);
        const blob = await response.blob();
        const buffer = await this._blobToBuffer(blob);
        this._applyRealMime(buffer);
        return buffer;
    }
}

class ComixHash {

    static get KEYS() {
        return [
            '13YDu67uDgFczo3DnuTIURqas4lfMEPADY6Jaeqky+w=', 'yEy7wBfBc+gsYPiQL/4Dfd0pIBZFzMwrtlRQGwMXy3Q=', 'yrP+EVA1Dw==',
            'vZ23RT7pbSlxwiygkHd1dhToIku8SNHPC6V36L4cnwM=', 'QX0sLahOByWLcWGnv6l98vQudWqdRI3DOXBdit9bxCE=', 'WJwgqCmf',
            'BkWI8feqSlDZKMq6awfzWlUypl88nz65KVRmpH0RWIc=', 'v7EIpiQQjd2BGuJzMbBA0qPWDSS+wTJRQ7uGzZ6rJKs=', '1SUReYlCRA==',
            'RougjiFHkSKs20DZ6BWXiWwQUGZXtseZIyQWKz5eG34=', 'LL97cwoDoG5cw8QmhI+KSWzfW+8VehIh+inTxnVJ2ps=', '52iDqjzlqe8=',
            'U9LRYFL2zXU4TtALIYDj+lCATRk/EJtH7/y7qYYNlh8=', 'e/GtffFDTvnw7LBRixAD+iGixjqTq9kIZ1m0Hj+s6fY=', 'xb2XwHNB'
        ];
    }

    static GenerateHash(path, bodySize = 0, time = 1) {
        const baseString = path + ':' + bodySize + ':' + time;
        const encoded = encodeURIComponent(baseString);
        const initialBytes = Buffer.from(encoded, 'utf-8');
        const result = ComixHash.Round5(ComixHash.Round4(ComixHash.Round3(ComixHash.Round2(ComixHash.Round1(initialBytes)))));
        return ComixHash.GetURLBase64FromBytes(result);
    }

    static Rc4(key, data) {
        if (!(key instanceof Uint8Array) || !(data instanceof Uint8Array)) {
            throw new TypeError('key and data must be Uint8Array');
        }
        if (key.length === 0) return data;
        const s = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            s[i] = i;
        }
        let j = 0;
        for (let i = 0; i < 256; i++) {
            j = (j + s[i] + key[i % key.length]) & 0xff;
            const temp = s[i];
            s[i] = s[j];
            s[j] = temp;
        }
        let i = 0;
        j = 0;
        const out = new Uint8Array(data.length);
        for (let k = 0; k < data.length; k++) {
            i = (i + 1) & 0xff;
            j = (j + s[i]) & 0xff;
            const temp = s[i];
            s[i] = s[j];
            s[j] = temp;
            const rnd = s[(s[i] + s[j]) & 0xff];
            out[k] = data[k] ^ rnd;
        }
        return out;
    }

    static GetBytesFromBase64(b64) {
        const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
        const pad = normalized.length % 4;
        if (pad) {
            normalized += '='.repeat(4 - pad);
        }
        return Buffer.from(normalized, 'base64');
    }

    static GetURLBase64FromBytes(bytes) {
        return Buffer.from(bytes).toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    static MutS(e) { return (e + 143) & 0xff; }
    static MutL(e) { return ((e >>> 1) | (e << 7)) & 0xff; }
    static MutC(e) { return (e + 115) & 0xff; }
    static MutM(e) { return (e ^ 177) & 0xff; }
    static MutF(e) { return (e - 188) & 0xff; }
    static MutG(e) { return ((e << 2) | (e >>> 6)) & 0xff; }
    static MutH(e) { return (e - 42) & 0xff; }
    static MutDollar(e) { return ((e << 4) | (e >>> 4)) & 0xff; }
    static MutB(e) { return (e - 12) & 0xff; }
    static MutUnderscore(e) { return (e - 20) & 0xff; }
    static MutY(e) { return ((e >>> 1) | (e << 7)) & 0xff; }
    static MutK(e) { return (e - 241) & 0xff; }
    static GetMutKey(mk, idx) { return mk.length > 0 && (idx % 32) < mk.length ? mk[idx % 32] : 0; }
    static GetKeyBytes(index) { return ComixHash.GetBytesFromBase64(ComixHash.KEYS[index]); }

    static Round1(data) {
        const enc = ComixHash.Rc4(ComixHash.GetKeyBytes(0), data);
        const mutKey = ComixHash.GetKeyBytes(1);
        const prefKey = ComixHash.GetKeyBytes(2);
        const out = [];
        for (let i = 0; i < enc.length; i++) {
            if (i < 7 && i < prefKey.length) out.push(prefKey[i]);
            let v = enc[i] ^ ComixHash.GetMutKey(mutKey, i);
            switch (i % 10) {
                case 0:
                case 9: v = ComixHash.MutC(v); break;
                case 1: v = ComixHash.MutB(v); break;
                case 2: v = ComixHash.MutY(v); break;
                case 3: v = ComixHash.MutDollar(v); break;
                case 4:
                case 6: v = ComixHash.MutH(v); break;
                case 5: v = ComixHash.MutS(v); break;
                case 7: v = ComixHash.MutK(v); break;
                case 8: v = ComixHash.MutL(v); break;
            }
            out.push(v & 0xff);
        }
        return new Uint8Array(out);
    }

    static Round2(data) {
        const enc = ComixHash.Rc4(ComixHash.GetKeyBytes(3), data);
        const mutKey = ComixHash.GetKeyBytes(4);
        const prefKey = ComixHash.GetKeyBytes(5);
        const out = [];
        for (let i = 0; i < enc.length; i++) {
            if (i < 6 && i < prefKey.length) out.push(prefKey[i]);
            let v = enc[i] ^ ComixHash.GetMutKey(mutKey, i);
            switch (i % 10) {
                case 0:
                case 8: v = ComixHash.MutC(v); break;
                case 1: v = ComixHash.MutB(v); break;
                case 2:
                case 6: v = ComixHash.MutDollar(v); break;
                case 3: v = ComixHash.MutH(v); break;
                case 4:
                case 9: v = ComixHash.MutS(v); break;
                case 5: v = ComixHash.MutK(v); break;
                case 7: v = ComixHash.MutUnderscore(v); break;
            }
            out.push(v & 0xff);
        }
        return new Uint8Array(out);
    }

    static Round3(data) {
        const enc = ComixHash.Rc4(ComixHash.GetKeyBytes(6), data);
        const mutKey = ComixHash.GetKeyBytes(7);
        const prefKey = ComixHash.GetKeyBytes(8);
        const out = [];
        for (let i = 0; i < enc.length; i++) {
            if (i < 7 && i < prefKey.length) out.push(prefKey[i]);
            let v = enc[i] ^ ComixHash.GetMutKey(mutKey, i);
            switch (i % 10) {
                case 0: v = ComixHash.MutC(v); break;
                case 1: v = ComixHash.MutF(v); break;
                case 2:
                case 8: v = ComixHash.MutS(v); break;
                case 3: v = ComixHash.MutG(v); break;
                case 4: v = ComixHash.MutY(v); break;
                case 5: v = ComixHash.MutM(v); break;
                case 6: v = ComixHash.MutDollar(v); break;
                case 7: v = ComixHash.MutK(v); break;
                case 9: v = ComixHash.MutB(v); break;
            }
            out.push(v & 0xff);
        }
        return new Uint8Array(out);
    }

    static Round4(data) {
        const enc = ComixHash.Rc4(ComixHash.GetKeyBytes(9), data);
        const mutKey = ComixHash.GetKeyBytes(10);
        const prefKey = ComixHash.GetKeyBytes(11);
        const out = [];
        for (let i = 0; i < enc.length; i++) {
            if (i < 8 && i < prefKey.length) out.push(prefKey[i]);
            let v = enc[i] ^ ComixHash.GetMutKey(mutKey, i);
            switch (i % 10) {
                case 0: v = ComixHash.MutB(v); break;
                case 1:
                case 9: v = ComixHash.MutM(v); break;
                case 2:
                case 7: v = ComixHash.MutL(v); break;
                case 3:
                case 5: v = ComixHash.MutS(v); break;
                case 4:
                case 6: v = ComixHash.MutUnderscore(v); break;
                case 8: v = ComixHash.MutY(v); break;
            }
            out.push(v & 0xff);
        }
        return new Uint8Array(out);
    }

    static Round5(data) {
        const enc = ComixHash.Rc4(ComixHash.GetKeyBytes(12), data);
        const mutKey = ComixHash.GetKeyBytes(13);
        const prefKey = ComixHash.GetKeyBytes(14);
        const out = [];
        for (let i = 0; i < enc.length; i++) {
            if (i < 6 && i < prefKey.length) out.push(prefKey[i]);
            let v = enc[i] ^ ComixHash.GetMutKey(mutKey, i);
            switch (i % 10) {
                case 0: v = ComixHash.MutUnderscore(v); break;
                case 1:
                case 7: v = ComixHash.MutS(v); break;
                case 2: v = ComixHash.MutC(v); break;
                case 3:
                case 5: v = ComixHash.MutM(v); break;
                case 4: v = ComixHash.MutB(v); break;
                case 6: v = ComixHash.MutF(v); break;
                case 8: v = ComixHash.MutDollar(v); break;
                case 9: v = ComixHash.MutG(v); break;
            }
            out.push(v & 0xff);
        }
        return new Uint8Array(out);
    }
}
