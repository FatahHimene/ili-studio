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
