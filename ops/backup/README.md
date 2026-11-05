# Sauvegardes du serveur ilidweb

Sauvegarde **chiffrée**, **chaque nuit à 03:30**, vers **Cloudflare R2** (bucket `ilidweb-backups`), avec [restic](https://restic.net).

**Contenu :** volume de données d'ili studio (comptes, sites, photos, messages), base de données de Coolify,
`.env` de Coolify, configuration et certificats du proxy, clés SSH de Coolify.

**Historique gardé :** 7 jours, 4 semaines, 6 mois. Le dimanche, une partie des données est relue pour vérifier qu'elles sont lisibles.

## Installation (une fois)

    apt -y install restic
    mkdir -p /root/ili-backup && chmod 700 /root/ili-backup
    # copier ili-backup.sh et backup.env.example dans /root/ili-backup, remplir backup.env
    chmod 700 /root/ili-backup/ili-backup.sh && chmod 600 /root/ili-backup/backup.env
    set -a; source /root/ili-backup/backup.env; set +a; export AWS_DEFAULT_REGION=auto
    restic init                       # crée le dépôt chiffré dans R2 (une seule fois)
    cp ili-backup.service ili-backup.timer /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now ili-backup.timer
    systemctl start ili-backup.service && journalctl -u ili-backup -n 30   # première sauvegarde

## Commandes utiles

    set -a; source /root/ili-backup/backup.env; set +a; export AWS_DEFAULT_REGION=auto
    restic snapshots                              # liste des sauvegardes
    restic ls latest | grep sites/ | head         # contenu de la dernière
    systemctl list-timers ili-backup.timer        # prochaine exécution
    journalctl -u ili-backup -n 50                # journal

## Restaurer

**Un seul site** (exemple : site `abc123`, version d'hier) :

    restic snapshots                                   # repérer l'ID de la sauvegarde voulue
    restic restore <ID> --target /root/restore --include '/var/lib/docker/volumes/*ili-studio-data/_data/sites/abc123'
    # puis recopier le dossier du site dans le volume, à la place de l'actuel

**Tout le serveur** (serveur neuf) : installer Coolify, restaurer `/data/coolify/source/.env` (même APP_KEY),
réimporter `coolify-db.sql`, recréer l'application ili studio, restaurer le contenu du volume `/data`, `/data/coolify/proxy`.

**Important :** le mot de passe `RESTIC_PASSWORD` est indispensable pour lire les sauvegardes. Il doit être dans le gestionnaire de mots de passe.
