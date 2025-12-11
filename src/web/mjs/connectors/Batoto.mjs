import AnyACG from './templates/AnyACG.mjs';

export default class Batoto extends AnyACG {

    constructor() {
        super();
        super.id = 'batoto';
        super.label = 'Batoto (by AnyACG)';
        this.tags = [ 'manga', 'multi-lingual' ];

        this.path = '/browse?sort=title&page=';
        this.queryMangaTitle = 'h3.item-title';
        this.queryMangaTitleText = 'a';
        this.queryMangaTitleFlag = 'span.item-flag';
        this.queryMangaPages = 'nav.d-none ul.pagination li.page-item:nth-last-child(2) a.page-link';
        this.queryMangas = 'div#series-list div.item-text';
        this.queryMangaLink = 'a.item-title';
        this.queryMangaFlag = 'span.item-flag';
        this.queryChapters = 'div.episode-list div.main a.visited';

        this.config = {
            url: {
                label: 'URL',
                description: `This website's main domain doesn't always work, but has alternate domains.\nThis is the default URL which can also be manually set by the user.`,
                input: 'text',
                value: 'https://bato.to'
            }
        };
    }

    get url() {
        return this.config.url.value;
    }

    set url(value) {
        if (this.config && value) {
            this.config.url.value = value;
            Engine.Settings.save();
        }
    }

    async _getPages(chapter) {
        let script = `
        (function(){
            return new Promise(resolve => {
                try {
                    const servers = ["k03","k06","k07","k00","k01","k02","k04","k05","k08","k09","n03","n00","n01","n02","n04","n05","n06","n07","n08","n09","n10"];

                    function buildCandidates(url) {
                        try {
                            const u = new URL(url);
                            const parts = u.hostname.split('.');
                            // only replace first label if it matches pattern like k03 or n05
                            if (/^[kn][0-9]{2}$/i.test(parts[0])) {
                                return servers.map(s => {
                                    const uu = new URL(url);
                                    uu.hostname = s + '.' + parts.slice(1).join('.');
                                    return uu.href;
                                });
                            }
                        } catch(e) {
                            // fall back to raw url
                        }
                        return [url];
                    }

                    function tryFetchWithTimeout(url, timeout) {
                        return new Promise(resolveFetch => {
                            try {
                                const controller = new AbortController();
                                const id = setTimeout(() => controller.abort(), timeout);
                                fetch(url, { method: 'HEAD', signal: controller.signal }).then(r => {
                                    clearTimeout(id);
                                    resolveFetch(r && r.ok ? url : null);
                                }).catch(() => { clearTimeout(id); resolveFetch(null); });
                            } catch(e) { resolveFetch(null); }
                        });
                    }

                    async function resolveUrl(url) {
                        const cands = buildCandidates(url);
                        for (let c of cands) {
                            const ok = await tryFetchWithTimeout(c, 5000);
                            if (ok) return ok;
                        }
                        return url; // fallback to original if none worked
                    }

                    setTimeout(() => {
                        (async () => {
                            try {
                                let imgs = [];
                                if(typeof app !== 'undefined' && typeof app.items !== 'undefined') {
                                    imgs = app.items.map(item => item.src || item.isrc).filter(Boolean);
                                } else if(typeof imgHttpLis !== 'undefined' && typeof batoWord !== 'undefined' && typeof batoPass !== 'undefined') {
                                    const params = JSON.parse(CryptoJS.AES.decrypt(batoWord, batoPass).toString(CryptoJS.enc.Utf8));
                                    imgs = imgHttpLis.map((data, i) => (data ? data + '?' + params[i] : null)).filter(Boolean);
                                }
                                if (imgs.length === 0) { resolve([]); return; }
                                const results = await Promise.all(imgs.map(url => resolveUrl(url)));
                                resolve(results);
                            } catch(e) {
                                resolve({ __hk_error: true, message: e.message, stack: e.stack });
                            }
                        })();
                    }, 2500);
                } catch(e) {
                    resolve({ __hk_error: true, message: e.message, stack: e.stack });
                }
            });
        })();
        `;
        let request = new Request(this.url + chapter.id, this.requestOptions);
        return Engine.Request.fetchUI(request, script);
    }
}
