import Connector from "../engine/Connector.mjs";
import Manga from "../engine/Manga.mjs";

export default class WestManga extends Connector {

    constructor() {
        super();
        super.id = "westmanga";
        super.label = "WestManga";
        this.tags = ["manga", "manhua", "manhwa", "indonesian"];
        this.url = "https://v1.westmanga.cc";
        this.api = {
            url: "https://data.mantweh.online/api/",
            nonce: "wm-api-request",
            accessKey: "WM_WEB_FRONT_END",
            secretKey: "xxxoidj",
        };

        this.config = {
            username: {
                label: 'Email',
                description: 'Email akun WestManga kamu untuk mengakses konten mature.',
                input: 'text',
                value: ''
            },
            password: {
                label: 'Password',
                description: 'Password akun WestManga kamu.',
                input: 'password',
                value: ''
            }
        };

        this.token = undefined;
        this._credentials = undefined;

        // Memicu proses login saat HakuNeko dimuat atau saat pengaturan disimpan
        Engine.Settings.addEventListener('loaded', this._onSettingsChanged.bind(this));
        Engine.Settings.addEventListener('saved', this._onSettingsChanged.bind(this));
    }

    async _getMangas() {
        const mangaList = [];
        for (let page = 1; ; page++) {
            const { data, paginator } = await this.fetchAPI(`contents?page=${page}&per_page=20&type=Comic`);
            if (!data || !data.length) {
                break;
            }
            mangaList.push(
                ...data.map(({ slug, title }) => ({
                    id: slug,
                    title: title.replace(/bahasa indonesia/i, "").trim(),
                }))
            );
            if (!paginator || paginator.current_page >= paginator.last_page) {
                break;
            }
        }
        return mangaList;
    }

    async _getChapters(manga) {
        const { data: { chapters } } = await this.fetchAPI(`comic/${manga.id}`);
        return chapters.map(({ slug, number }) => {
            let title = number.toString().trim();
            if (!/^chapter\s+/i.test(title)) {
                title = `Chapter ${title}`;
            }
            return {
                id: slug,
                title: title,
            };
        });
    }

    async _getPages(chapter) {
        const { data: { images } } = await this.fetchAPI(`v/${chapter.id}`);
        return images;
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split("/").filter(Boolean).pop();
        const { data: { title } } = await this.fetchAPI(`comic/${slug}`);
        return new Manga(this, slug, title.replace(/bahasa indonesia/i, "").trim());
    }

    _onSettingsChanged() {
        let user = this.config.username.value;
        let pass = this.config.password.value;
        let credentials = user + pass;

        // Hanya proses login jika ada perubahan pada email/password
        if (this._credentials !== credentials) {
            this._credentials = credentials;
            this._login(user, pass)
                .then(() => {
                    if (this.token) console.log(this.label + ' login berhasil!');
                })
                .catch(error => {
                    console.warn(this.label + ' login gagal!', error);
                });
        }
    }

    async _login(username, password) {
        // Reset token saat ini
        this.token = undefined;

        // Abaikan jika form kosong (Guest Mode)
        if (typeof username !== 'string' || username === '' || typeof password !== 'string' || password === '') {
            return Promise.resolve();
        }

        const url = new URL("auth/login", this.api.url);
        const timestamp = `${Date.now()}`.slice(0, -3);
        const signature = await this.generateHMAC256(
            this.api.nonce,
            timestamp,
            "POST",
            url.pathname,
            this.api.accessKey,
            this.api.secretKey
        );

        const headers = {
            ...this.requestOptions.headers,
            "Content-Type": "application/json",
            Referer: this.url,
            "X-Wm-Request-Time": timestamp,
            "X-Wm-Accses-Key": this.api.accessKey,
            "X-Wm-Request-Signature": signature,
        };

        const request = new Request(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                email: username,
                password: password
            })
        });

        const data = await this.fetchJSON(request);

        if (data && data.access_token) {
            this.token = data.access_token;
        } else if (data && data.data && data.data.access_token) {
            this.token = data.data.access_token;
        } else {
            throw new Error("Kredensial tidak valid atau struktur response berubah.");
        }
    }

    async fetchAPI(endpoint, isGenre = false) {
        const url = new URL(endpoint, this.api.url);
        const timestamp = `${Date.now()}`.slice(0, -3);
        const signature = await this.generateHMAC256(
            this.api.nonce,
            timestamp,
            "GET",
            url.pathname,
            this.api.accessKey,
            this.api.secretKey
        );

        const headers = {
            ...this.requestOptions.headers,
            Referer: this.url,
            "X-Wm-Request-Time": timestamp,
            "X-Wm-Accses-Key": this.api.accessKey,
            "X-Wm-Request-Signature": signature,
        };

        // Jika request bukan untuk Genre dan kita punya token (sudah sukses login)
        if (!isGenre && this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        const request = new Request(url, {
            ...this.requestOptions,
            headers,
        });

        return this.fetchJSON(request);
    }

    async generateHMAC256(data, ...keyData) {
        const key = keyData.join("");
        const hash = CryptoJS.HmacSHA256(data, key);
        return CryptoJS.enc.Hex.stringify(hash);
    }
}
