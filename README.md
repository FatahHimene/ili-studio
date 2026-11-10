# ili studio · prototype (étape 1)

Importer un site (ZIP ou HTML fait avec ChatGPT, Claude, Lovable…), cliquer sur n'importe quel élément pour le modifier, puis publier.

## Ce que fait cette version

- **Import** d'un `.zip` ou `.html` : détection du dossier du site (`dist/`, `build/`…), chemins `/…` rendus relatifs, fichiers dangereux refusés.
- **Éditeur visuel** : survol et sélection des éléments, texte modifiable sur place (double-clic), images (remplacer, texte alternatif), liens, déplacer, dupliquer, supprimer, sélectionner le parent.
- **Aperçu** ordinateur / tablette / mobile, mode Édition ou Aperçu.
- **Annuler** (50 étapes par page), **Publier** vers `/s/<adresse-du-site>/`.
- **Sécurité** : connexion par mot de passe, le code des sites tourne dans un bac à sable (il ne peut pas lire l'admin), protection contre les archives piégées.

- **Wren (IA)** : sélectionner un élément et demander une modification (réécrire, raccourcir, moderniser une section…). Chaque modification peut être annulée.
- **Style** : couleurs, taille, graisse, alignement, arrondis, espace intérieur.

- **Thèmes** : créer un site à partir d'un thème conçu par un designer ; Wren remplit les textes et la banque d'images ajoute les photos, à partir du brief du client.
- **Admin des thèmes** (`/themes`) : ajouter, mettre à jour ou supprimer un thème en déposant un ZIP.
- **Banque de photos gratuite** (Pixabay) dans l'éditeur, avec suggestions de recherche par Wren ; photos et images téléversées redimensionnées et compressées en WebP.

Pas encore : comptes clients, crédits, domaines personnalisés, paiement, ajout de pages/sections, styles globaux du site.

## Photos (Pixabay)

Créer une clé gratuite sur https://pixabay.com/api/docs/ (connecté, la clé apparaît dans la page), puis dans CapRover :

```
PIXABAY_API_KEY=votre-cle
```

## Format d'un thème

Un thème est un dossier (ou un ZIP de ce dossier) :

```
theme.json        {"id": "artisan-bold", "name": "…", "category": "Trades", "description": "…", "version": "1.0.0",
                   "pages": ["index.html", "contact.html"],
                   "templates": [{"id": "about", "name": "About us", "file": "templates/about.html", "path": "about.html"}]}
index.html …      les pages du thème
assets/           CSS, polices, images, scripts
templates/*.html  modèles de pages ajoutables plus tard (facultatif)
preview.png       capture pour la galerie (facultatif)
```

Dans le HTML, les zones personnalisables sont des **slots** :

| Attribut | Rôle |
|---|---|
| `data-ili-slot="hero.title"` | texte écrit par Wren (`data-ili-hint`, `data-ili-max` l'aident) |
| `data-ili-type="business\|phone\|email\|town\|address"` | fait inséré tel quel depuis le brief, jamais inventé |
| `data-ili-optional` | retiré si le fait est absent (ex. pas d'e-mail) |
| `<img data-ili-slot="hero.image" data-ili-query="electrician at work" data-ili-orientation="horizontal">` | photo choisie dans la banque |

Les thèmes intégrés sont dans `themes/` du dépôt ; ceux ajoutés par l'admin sont stockés dans `/data/themes` (un thème ajouté avec le même `id` remplace l'intégré).

## Activer Wren

Dans CapRover → App Configs → Environmental Variables, ajouter **une** des deux options :

```
# Test gratuit avec Gemini (clé sur aistudio.google.com)
GEMINI_API_KEY=votre-cle
# GEMINI_MODEL=gemini-flash-latest   (facultatif)

# ou Azure (Azure AI Foundry : déployer un modèle, puis copier endpoint + clé)
AZURE_OPENAI_ENDPOINT=https://votre-ressource.openai.azure.com
AZURE_OPENAI_API_KEY=votre-cle
AZURE_OPENAI_DEPLOYMENT=nom-du-deploiement
# AZURE_OPENAI_REASONING_EFFORT=minimal   (facultatif, pour les modèles « reasoning »)

# ou Claude (clé sur console.anthropic.com)
ANTHROPIC_API_KEY=votre-cle
# ANTHROPIC_MODEL=claude-haiku-5-5   (facultatif)
```

Attention : avec l'offre gratuite de Gemini, Google peut utiliser les contenus envoyés pour améliorer ses produits. À réserver aux tests, jamais aux sites de vrais clients.

## Déployer sur CapRover

1. **Create New App** → nom `ili-studio` → cocher **Has Persistent Data** → Create.
2. Onglet **App Configs** :
   - **Persistent Directories** : chemin dans l'app `/data`, étiquette `ili-studio-data`.
   - **Environmental Variables** (mode Bulk Edit) :
     ```
     ADMIN_PASSWORD=un-mot-de-passe-long
     ADMIN_EMAIL=admin            (optionnel : identifiant admin, « admin » par défaut)
     FREE_DOMAIN=yela.uk          (optionnel : domaine des sites gratuits)
     SESSION_SECRET=une-longue-chaine-aleatoire
     ```
   - **Container HTTP Port** : `3000`.
   - Sans nom de domaine : **Port Mapping** `8080` (serveur) → `3000` (conteneur), puis ouvrir `http://IP-DU-SERVEUR:8080`.
   - Save & Update.
3. Onglet **Deployment** → *Method 3: Deploy from Github* :
   - Repository : `github.com/FatahHimene/ili-studio`, Branch : `main`
   - Username : votre identifiant GitHub, Password : un **token GitHub** (Settings → Developer settings → Fine-grained token, accès *Contents: Read-only* à ce dépôt uniquement)
   - Save & Update, puis **Force Build**.
4. Mise à jour automatique : copier l'URL du webhook affichée par CapRover dans GitHub → dépôt → Settings → Webhooks → Add webhook (Content type `application/json`).

## Développement local

```
npm install
ADMIN_PASSWORD=test npm run dev   # http://localhost:3000
```

Les données sont dans `./data` (ou `DATA_DIR`).


## Comptes clients et offres

- Les clients créent leur compte sur `/signup` (e-mail + mot de passe, hachés en scrypt dans `DATA_DIR/users`).
- L'admin se connecte avec `ADMIN_EMAIL` (par défaut `admin`) et `ADMIN_PASSWORD`. Lui seul voit l'admin des thèmes et tous les sites.
- Après l'inscription, l'écran `/welcome` présente les offres (Free, Essential, Plus, Pro, définies dans `src/plans.js`).
  Le paiement n'est pas encore branché : un choix payant est enregistré (`wantsPlan`) et le client continue en gratuit.
- Crédits IA : 30 à l'inscription (Free). Wren coûte 1 crédit (texte) ou 2 (bloc). La première création d'un site et la recherche de photos sont gratuites.
  À 0 crédit, l'éditeur propose « Continuer manuellement » ou les offres.
- Publication : le client choisit son adresse `nom.yela.uk`. En Free, seule la page d'accueil est publiée (les liens vers les autres pages
  sont retirés), avec un petit lien « Website made with ili studio by Ilidweb » en bas.
- Les sites gratuits sont servis directement selon le nom d'hôte `*.FREE_DOMAIN` (DNS : `*` et `@` vers l'IP du serveur).

## Formulaires de contact

- Dans un thème : `<form data-ili-form="contact">` avec des champs nommés (`name`, `email`, `phone`, `message`…).
  À la publication, le formulaire est envoyé à `_form` sur le même domaine que le site, avec un champ piège anti-robots.
- Les messages arrivent dans **Messages** (tableau de bord du client) et une copie part par e-mail à l'adresse du compte client
  (« Répondre » écrit directement au visiteur). Si le thème a une page `thanks.html`, le visiteur y est redirigé.
- Limites : 5 envois par connexion et par 10 minutes, 60 messages par site et par jour.
- Variables d'environnement pour l'e-mail (n'importe quel compte SMTP, par exemple `noreply@ilidweb.uk` créé dans DirectAdmin) :

     SMTP_HOST=mail.ilidweb.uk
     SMTP_PORT=587
     SMTP_USER=noreply@ilidweb.uk
     SMTP_PASS=…                (dans CapRover uniquement)
     SMTP_FROM=ili studio <noreply@ilidweb.uk>
     APP_URL=https://studio.ilidweb.uk
     ADMIN_NOTIFY_EMAIL=…       (optionnel : copie des messages des sites de l'admin)

## Avis clients

- Dans un thème : un bloc `data-ili-reviews` contenant une carte modèle `data-ili-review` avec `data-ili-review-rating`, `-text`,
  `-author`, `-date`, `-source` et `a[data-ili-review-link]` ; en option `data-ili-reviews-summary` et `a[data-ili-reviews-cta]`.
- Dans l'éditeur, le bouton **★ Reviews** (visible si le site a un bloc d'avis) : le client choisit la plateforme (Google, Trustpilot,
  Facebook, Checkatrade, TrustATrader, Yell…), puis ajoute ses avis lui-même (affichés dans le design du thème, avec confirmation
  qu'ils sont authentiques) ou colle le widget officiel de la plateforme (scripts et iframes acceptés uniquement depuis des plateformes connues).

## SEO de base (automatique à la publication)

Titre et description par page, adresse canonique, aperçu de partage (Open Graph / Twitter), données structurées
LocalBusiness sur l'accueil (à partir du brief), chargement différé des images, `sitemap.xml` et `robots.txt`.
La page `thanks.html` est en `noindex` et ne compte pas dans la limite de pages.

## Outil SEO (menu « SEO »)

- Un seul compte pour tout : sites ili studio, messages et SEO. `/signup?next=seo` ouvre directement l'outil SEO.
- **Audit** des sites ili studio (pages en préparation) et de n'importe quel site public (exploration de 5 pages en Free,
  20 sinon ; protections contre les adresses internes). Score sur 100, problèmes classés (à corriger, à améliorer, conseils).
- **Améliorations** pour les sites ili studio : titre et description de chaque page avec aperçu Google, « Write with Wren »
  (1 crédit), descriptions d'images, liens vers l'éditeur. Pour les sites externes : liste des changements + proposition ili studio.
- **Advanced SEO** : onglet « Bientôt disponible ».
- Avant de publier, la fenêtre de publication montre le score SEO avec « Finalise my SEO first ».
- Vitesse mobile via l'API PageSpeed de Google (gratuite) ; `PAGESPEED_API_KEY` optionnel pour un quota plus élevé.
- Limites : 1 site externe en Free, 5 sur les offres payantes.

## Deux serveurs : ili-studio et ili-sites

Le même code tourne en deux apps séparées :

| App | `MODE` | Rôle | Données |
|---|---|---|---|
| **ili-studio** | (vide) | éditeur, comptes, IA, SEO, messages | volume `ili-studio-data` → `/data` |
| **ili-sites** | `sites` | sert uniquement les sites publiés (`*.yela.uk`) | volume `ili-sites-data` → `/data/live` |

- À chaque publication, ili-studio envoie le site (ZIP) à ili-sites (`PUT /_internal/sites/<adresse>`, protégé par `SITES_SECRET`). Dépublier ou supprimer un site le retire d'ili-sites.
- Les formulaires des sites arrivent sur ili-sites, qui les transmet à ili-studio (`POST /_internal/form`). ili-studio garde le message et l'envoie par e-mail au client.
- Au démarrage puis toutes les 6 h, ili-studio remet ili-sites à jour : il envoie les sites manquants et retire ceux qui ne sont plus publiés. Une app ili-sites neuve ou vidée se remplit donc toute seule.
- Comme tout passe par HTTP, ili-sites peut être déplacé sur un autre VPS : seul `SITES_URL` change dans ili-studio.
- Si ili-studio n'a pas de `SITES_URL`, il sert lui-même les sites, comme avant.

Variables :

```
# ili-studio
SITES_URL=http://ili-sites:3000
SITES_SECRET=<openssl rand -hex 32>   # la même valeur dans les deux apps

# ili-sites
MODE=sites
SITES_SECRET=<la même valeur>
STUDIO_URL=http://ili-studio:3000
```

## Suppression et nettoyage

- **Supprimer un site** : retire aussi sa copie en ligne sur ili-sites, son historique, ses messages et son audit SEO (`src/cleanup.js`).
- **Le client supprime son compte** : page **Mon compte** (`/account`, lien sur son e-mail en haut du tableau de bord), confirmation par mot de passe. Tous ses sites, messages et contrôles SEO sont supprimés (UK GDPR, droit à l'effacement). Les sauvegardes chiffrées disparaissent au bout de 6 mois.
- **Page admin Clients** (`/clients`) : tous les comptes avec offre, crédits IA, sites, espace disque et dernière connexion. L'admin peut changer l'offre (en attendant le paiement par carte), modifier les crédits ou supprimer un compte (confirmation en tapant l'e-mail du client).
- **Nettoyage automatique** chaque nuit vers 04:00, après la sauvegarde de 03:30 : sites dont le compte n'existe plus, audits SEO orphelins, publications interrompues, fichiers envoyés de plus de 24 h.
- Si un site ne peut pas être mis hors ligne (ili-sites ne répond pas), rien n'est supprimé et un message demande de réessayer : rien ne reste à moitié supprimé.

## Versions des sites

- Les modifications sont enregistrées automatiquement dans le brouillon. Le site en ligne ne change qu'au clic sur **Publier**. Dans l'éditeur, l'indicateur « Saved » le confirme, et le bouton devient **Publish changes ●** quand des modifications ne sont pas encore en ligne.
- Le bouton **Versions** de l'éditeur sert à :
  - enregistrer une version nommée ;
  - revenir à une version : l'état actuel est d'abord gardé comme version « Auto », donc on peut annuler le retour. Rien n'est mis en ligne avant de publier ;
  - télécharger une version, ou le site actuel, en ZIP de fichiers HTML propres.
- Une version est créée automatiquement à chaque publication.
- Nombre de versions gardées selon l'offre : Free 1, Essential 5, Plus 15, Pro 30 (`versions` dans `src/plans.js`). Les plus anciennes sont supprimées automatiquement.
- Stockage : `sites/<id>/versions/`. Un fichier identique à celui de la version précédente est lié (hard link), pas recopié : les photos ne prennent pas de place en double.

## Statistiques de visites

- **Onglet Stats** (`/stats`). Pour chaque site :
  - visiteurs, pages vues et messages reçus, comparés à la période précédente ;
  - une courbe par jour, ou par semaine au-delà de 4 mois ;
  - les pages les plus vues, d'où viennent les visiteurs (Google, Facebook, Yell, `?utm_source=` …), les pays et les appareils.
- L'admin a aussi une vue « All sites » : les totaux de la plateforme et les sites les plus visités.
- **Historique selon l'offre** (`statsDays` dans `src/plans.js`) : Free 30 jours, Essential 6 mois, Plus et Pro 2 ans.
- **Où se fait le comptage** : là où les sites sont servis, donc sur ili-sites, ou sur ili-studio s'il n'a pas de `SITES_URL` (`src/stats.js`).
- **Sans cookie et sans script dans les pages.**
  - Un visiteur est compté une fois par jour, grâce à une empreinte (secret du jour + site + IP + navigateur).
  - Le secret change chaque jour et n'est jamais enregistré. Seuls les totaux sont gardés : `DATA_DIR/stats/<siteId>/<jour>.json`, conservés environ 2 ans.
  - Les robots et les préchargements ne sont pas comptés.
- **Pays** : base DB-IP Lite, licence CC BY 4.0. Elle est téléchargée au démarrage puis tous les 30 jours dans `DATA_DIR/geo`, depuis jsDelivr ou unpkg (paquet `@ip-location-db/dbip-country`). La mention « IP Geolocation by DB-IP » doit rester sur la page Stats. Quand Cloudflare fournit `CF-IPCountry`, cette information est utilisée en priorité.
- **Suppression** : supprimer un site efface aussi ses statistiques. Le dépublier les garde.

## Modules (Contact, Avis, puis Réservation, Paiement, Boutique)

- **Bouton « ✦ Modules » dans l'éditeur.** Il ajoute un module après la section sélectionnée, ou en bas de page avant le pied de page.
  - Les modules payants (Réservation et planning, Paiement en ligne, Mini boutique) apparaissent avec leur offre et la mention « Coming soon ».
  - Quand on clique sur un module dans l'aperçu, le panneau de droite affiche son bouton de réglages.
- **Les modules prennent le style du thème sans être écrits pour lui :**
  - **variables CSS standard des thèmes** : `--ili-primary`, `--ili-accent`, `--ili-ink`, `--ili-bg`, `--ili-soft`, `--ili-font-head`, `--ili-font-body`, `--ili-radius` ;
  - **`"ui"` dans `theme.json`** (facultatif) : les classes du thème que les modules réutilisent :
    ```json
    "ui": { "button": "btn alt", "buttonAlt": "btn", "form": "form", "section": "contact", "container": "wrap" }
    ```
  - **CSS de base des modules** (`MODULE_CSS` dans `src/modules.js`) : écrit avec `:where()`, donc le CSS du thème garde toujours la priorité.
- **Module Contact** (`<div data-ili-module="contact"></div>` dans une page) :
  - boutons WhatsApp (avec un premier message déjà rempli), Appeler et E-mail ;
  - bouton WhatsApp rond en bas de toutes les pages, en option ;
  - formulaire avec jusqu'à 12 champs que le client gère lui-même : texte, e-mail, téléphone, texte long, liste de choix, date ; chaque champ peut être obligatoire ;
  - texte du bouton et petite mention sous le formulaire modifiables.
- **Réglages du module Contact** :
  - ils sont enregistrés pour tout le site, dans `meta.contact` ;
  - l'emplacement est rempli à l'affichage (aperçu de l'éditeur et publication), jamais écrit dans le brouillon : le module reste toujours à jour.
- **Messages reçus par le module Contact** :
  - seuls les champs prévus sont acceptés, et les champs obligatoires ainsi que les listes de choix sont vérifiés ;
  - le nom de chaque champ est gardé avec le message (`labels`).
- **Adresses de réception** : l'adresse du compte, plus jusqu'à 3 adresses en plus. Ces adresses ne reçoivent les messages qu'une fois confirmées. La confirmation par e-mail arrive avec l'étape « envoi des e-mails ».
- **Formulaires écrits dans les thèmes** (`<form data-ili-form>`) : ils continuent de marcher, pour les sites déjà créés.
- **Thème avec son propre formulaire** :
  - à la création du site, chaque `<form data-ili-form>` du thème devient un emplacement Contact ;
  - le module est activé avec les champs, le bouton et la mention du formulaire du thème, ainsi qu'avec le téléphone et l'e-mail du brief ;
  - c'est la même chose pour les pages modèles du thème ajoutées plus tard ;
  - pour les sites déjà créés, la fenêtre Modules propose « Switch to the Contact module » (`POST /api/sites/:id/modules/adopt`, qu'on peut annuler avec Undo).
- **Style des boutons Contact** (`look` dans `meta.contact`) :
  - `theme` (par défaut) : le thème décide, avec `"contactLook"` dans le `ui` de `theme.json` : `buttons`, `brand`, `links` ou `text` ;
  - `buttons` : boutons du thème ;
  - `brand` : comme `buttons`, mais WhatsApp en vert ;
  - `links` : icône et texte ;
  - `text` : texte seul.

  Chaque action (WhatsApp, Appeler, E-mail) peut aussi recevoir sa propre couleur. Le texte passe alors automatiquement en noir ou en blanc selon le fond.

## E-mails

- **Variables à mettre dans l'app ili-studio** (Coolify) : `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (`ili studio <noreply@ilidweb.uk>`), `SMTP_SECURE` (`true` seulement pour le port 465), `APP_URL` (`https://studio.ilidweb.uk`).
- **E-mails envoyés** (`src/emails.js`) :
  - bienvenue, à l'inscription ;
  - lien « mot de passe oublié » (1 h, utilisable une seule fois) ;
  - confirmation d'une adresse de réception ajoutée au module Contact (7 jours) ;
  - confirmation d'un changement d'adresse e-mail (24 h), avec un avis envoyé à l'ancienne adresse ;
  - copie des messages des formulaires au propriétaire et aux adresses confirmées.
- **Liens signés** avec `SESSION_SECRET`, sans base de données (`makeToken` et `readToken` dans `auth.js`). Le lien de réinitialisation est lié au mot de passe actuel : il ne marche plus une fois utilisé.
- **« Mot de passe oublié »** donne la même réponse que le compte existe ou non. Les demandes sont limitées par IP et par adresse.
- **Page admin Clients** : elle indique si l'envoi d'e-mails est actif et permet d'envoyer un e-mail de test.

## Paiement (Blesta)

- **Prix facturés une fois par an**, sans prélèvement automatique : Essential 39 £, Plus 69 £, Pro 119 £. Ils sont affichés au mois : 3,25 £, 5,75 £ et 9,92 £. Le domaine est inclus tant que l'offre est active.
- **Parcours client**
  1. Le client choisit une offre.
  2. ili studio crée son compte client Blesta (même e-mail, sans e-mail Blesta), un service en attente et la facture.
  3. Le client est envoyé sur la page de paiement, déjà connecté (plugin **Shared Login**).
  4. Il paie par PayPal ou par carte.
  5. Le plugin **Webhooks** de Blesta appelle `POST /_internal/blesta/<BLESTA_WEBHOOK_KEY>`.
  6. ili studio relit les services du client par l'API et active l'offre et les crédits IA. Le contenu du webhook n'est jamais pris pour argent comptant.
- **Vérifications de secours** : au retour du client (`/api/me`) et toutes les 6 h.
- **Si aucune offre n'est active** (suspendue ou annulée), le compte repasse en Free. Rien n'est supprimé.
- **« Mon compte »** : liens « My invoices » et « Support tickets » (`/billing/invoices`, `/billing/support`), qui ouvrent Blesta déjà connecté.
- **Variables Coolify** (app ili-studio) : `BLESTA_URL`, `BLESTA_API_USER`, `BLESTA_API_KEY`, `BLESTA_SHARED_KEY`, `BLESTA_PACKAGES=essential:25,plus:26,pro:27`, `BLESTA_WEBHOOK_KEY`.
- **Si Blesta n'est pas configuré**, le choix d'offre est seulement enregistré, comme avant.

## Domaine du client (offres payantes)

Le client met son site sur son propre domaine depuis le bouton **Domain** (éditeur) ou **Add domain** (tableau de bord). Un bandeau l'y invite quand son offre payante n'a encore aucun domaine.

Trois choix : *Get a new domain, free* et *Move my domain to you* (en préparation, via Blesta), et *Connect my domain*, qui fonctionne :

1. Le client tape son domaine. ili studio affiche deux enregistrements : `A @ → SITES_IP` et `CNAME www → connect.yela.uk`.
2. ili studio vérifie le DNS (bouton *Check now*, et toutes les 10 minutes). Il faut que le domaine **et** `www` pointent vers `SITES_IP`.
3. Dès que c'est bon : statut `live`, ili-sites répond sur le domaine, `www` et l'adresse gratuite redirigent vers lui, et un e-mail prévient le client.
4. ili-sites écrit `ili-domains.yaml` dans le dossier dynamique de Traefik : Traefik obtient alors le certificat HTTPS (Let's Encrypt, défi HTTP).

Si l'offre redevient gratuite, le domaine passe en `paused` et le site revient sur son adresse gratuite.

Réglages :
- ili-studio : `SITES_IP` = adresse IP publique du VPS (plusieurs séparées par des virgules) ; `SITES_CNAME` (par défaut `connect.yela.uk`).
- ili-sites : volume `/data/coolify/proxy/dynamic` (hôte) → `/traefik` (conteneur), et `TRAEFIK_DIR=/traefik`. `TRAEFIK_TARGET` (par défaut `http://ili-sites:3000`).
- Cloudflare : `connect.yela.uk` en `A` vers l'IP du VPS, **proxy désactivé (nuage gris)**.

### Domaine offert (enregistré chez nous)

Avec une offre payante, le client a droit à **un domaine offert par compte**, en `.co.uk`, `.uk` ou `.org.uk` (fenêtre Domaine, *Get a new domain, free*) :

1. Il cherche un nom. ili studio interroge Internet.bs pour les trois extensions.
2. Il choisit un nom, puis remplit le titulaire : lui-même, son entreprise individuelle ou sa société (avec le numéro d'entreprise), l'adresse au Royaume-Uni et le téléphone. Ces coordonnées mettent à jour son contact dans Blesta.
3. ili studio crée dans Blesta un service domaine à **0 £** (prix forcé), avec le module, qui enregistre le domaine chez Internet.bs à son nom. Les serveurs DNS sont ceux d'Internet.bs (`REG_NAMESERVERS`).
4. ili studio écrit dans le DNS d'Internet.bs `A @ → SITES_IP` et `CNAME www → connect.yela.uk`, en réessayant toutes les 10 minutes si besoin. Le domaine passe ensuite `live` tout seul, comme un domaine branché.

Le domaine est noté dans le compte (`freeDomain`). Le client peut le remettre sur un autre de ses sites en un clic (*Use my free domain*). Si l'offre redevient gratuite, le domaine reste à lui. Un avertissement apparaît dans les logs (`should renew at the normal price`) pour que l'admin retire le prix à 0 dans Blesta.

Réglages (ili-studio) :
- `INTERNETBS_API_KEY`, `INTERNETBS_PASSWORD`. L'IP du VPS doit être autorisée pour l'API dans le compte Internet.bs. `INTERNETBS_TEST=1` utilise l'API de test.
- `BLESTA_DOMAIN_PACKAGES` (par défaut `.uk:10,.co.uk:11,.org.uk:12`) : l'offre Blesta de chaque extension offerte. Il faut un prix 1 an en GBP.
- Le compte Internet.bs doit avoir du crédit : c'est lui qui paie l'enregistrement.

Le transfert de domaine viendra plus tard. On attend de savoir si le registrar change.
