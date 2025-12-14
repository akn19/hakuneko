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
        new Promise(resolve => {
            setTimeout(() => {
                let urls = [];
                if(typeof app.items !== 'undefined') {
                    urls = app.items.map(item => item.src || item.isrc);
                } else {
                    const params = JSON.parse(CryptoJS.AES.decrypt(batoWord, batoPass).toString(CryptoJS.enc.Utf8));
                    urls = imgHttpLis.map((data, i) => \`\${data}?\${params[i]}\`);
                }

                // Replace all k servers to n servers
                const results = urls.map(url => {
                    try {
                        const u = new URL(url);
                        const parts = u.hostname.split('.');
                        if (/^k[0-9]{2}$/i.test(parts[0])) {
                            const serverNum = parts[0].substring(1);
                            u.hostname = 'n' + serverNum + '.' + parts.slice(1).join('.');
                            return u.href;
                        }
                    } catch(e) {
                    }
                    return url;
                });

                resolve(results);
            }, 2500);
        });
        `;
        // Fix double slash in URL
        const chapterId = chapter.id.startsWith('/') ? chapter.id : '/' + chapter.id;
        const baseUrl = this.url.endsWith('/') ? this.url.slice(0, -1) : this.url;
        let request = new Request(baseUrl + chapterId, this.requestOptions);
        return Engine.Request.fetchUI(request, script);
    }
}
