# Voxel Frontier

Voxelová survival hra fungující jako samostatný `index.html`. Singleplayer a ruční WebRTC připojení fungují přímo z disku i na GitHub Pages.

## Automatický LAN multiplayer

1. Nainstaluj [Node.js 20+](https://nodejs.org/).
2. Na Windows spusť dvojklikem `Spustit-LAN-Windows.cmd`, na macOS `Spustit-LAN-macOS.command`.
3. Launcher můžeš stáhnout samostatně. Při prvním spuštění si sám stáhne potřebné herní soubory, nainstaluje komponenty, spustí helper a otevře `http://localhost:8080`.
4. Hostitel vybere svět a klikne na **Hostovat LAN**.
5. Ostatní hráči spustí stejný launcher. Místnost se automaticky objeví v lobby bez zadávání IP.

Server podporuje až 8 hráčů v jedné místnosti. Hostitel sdílí seed a úpravy bloků, zatímco inventář, zdraví a hlad zůstávají každému hráči vlastní.

## Android

Android aplikace automaticky spustí stejný LAN helper uvnitř telefonu. V menu stačí kliknout na **Hostovat LAN**; ostatní spuštěné instance na Windows, macOS nebo Androidu místnost automaticky najdou.

APK se sestavuje v GitHub Actions workflow **Build Android APK**. Po dokončení stáhni artifact `voxel-frontier-lan-android` a nainstaluj `app-debug.apk`. Android může při první instalaci požádat o povolení instalace z tohoto zdroje.

### Spuštění z GitHub Pages

Na GitHub Pages klikni na **Stáhnout a spustit LAN**. Stránka nabídne Windows/macOS launcher nebo Android APK podle zařízení. Po stažení je nutné soubor jednou ručně spustit, protože webový prohlížeč nesmí sám spouštět programy. Pro připojení k již běžícímu hostiteli lze také zadat jeho LAN adresu a kliknout na **Otevřít LAN**.

## WebRTC připojení

1. Hostitel klikne na **Vytvořit nabídku** a pošle vzniklý kód druhému hráči.
2. Druhý hráč vloží kód, klikne na **Přijmout nabídku** a pošle hostiteli vytvořenou odpověď.
3. Hostitel vloží odpověď a klikne na **Přijmout odpověď**.

Při spuštění přes LAN server mají nabídka i odpověď pouze 6 znaků a platí 5 minut. Bez serveru režim stále funguje přes `file://` nebo GitHub Pages, ale kód musí obsahovat celý technický popis spojení, a proto je výrazně delší.
