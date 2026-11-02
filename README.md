# ili studio · prototype (étape 1)

Importer un site (ZIP ou HTML fait avec ChatGPT, Claude, Lovable…), cliquer sur n'importe quel élément pour le modifier, puis publier.

## Ce que fait cette version

- **Import** d'un `.zip` ou `.html` : détection du dossier du site (`dist/`, `build/`…), chemins `/…` rendus relatifs, fichiers dangereux refusés.
- **Éditeur visuel** : survol et sélection des éléments, texte modifiable sur place (double-clic), images (remplacer, texte alternatif), liens, déplacer, dupliquer, supprimer, sélectionner le parent.
- **Aperçu** ordinateur / tablette / mobile, mode Édition ou Aperçu.
- **Annuler** (50 étapes par page), **Publier** vers `/s/<adresse-du-site>/`.
- **Sécurité** : connexion par mot de passe, le code des sites tourne dans un bac à sable (il ne peut pas lire l'admin), protection contre les archives piégées.

Pas encore : IA (Wren), comptes clients, domaines personnalisés, paiement.

## Déployer sur CapRover

1. **Create New App** → nom `ili-studio` → cocher **Has Persistent Data** → Create.
2. Onglet **App Configs** :
   - **Persistent Directories** : chemin dans l'app `/data`, étiquette `ili-studio-data`.
   - **Environmental Variables** (mode Bulk Edit) :
     ```
     ADMIN_PASSWORD=un-mot-de-passe-long
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
