# Commit hash + date for the version line on the page (.git is only read in this stage).
FROM alpine/git:2.54.0 AS version
WORKDIR /src
COPY .git .git
RUN git -c safe.directory='*' log -1 --format='{"commit":"%h","date":"%cs"}' > /version.json

FROM php:8.5.12-apache

# mod_headers/deflate for .htaccess caching + compression; allow .htaccess overrides.
RUN a2enmod headers deflate proxy proxy_http \
 && sed -ri 's!AllowOverride None!AllowOverride All!' /etc/apache2/apache2.conf \
 && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && echo 'ServerTokens Prod' > /etc/apache2/conf-enabled/zz-hardening.conf \
 && echo 'ServerSignature Off' >> /etc/apache2/conf-enabled/zz-hardening.conf \
 && echo 'expose_php = Off' > "$PHP_INI_DIR/conf.d/zz-chess.ini" \
 && mkdir -p /data && chown www-data:www-data /data

COPY --chown=www-data:www-data index.html .htaccess /var/www/html/
COPY --chown=www-data:www-data css /var/www/html/css
COPY --chown=www-data:www-data js /var/www/html/js
COPY --chown=www-data:www-data img /var/www/html/img
COPY --chown=www-data:www-data vendor /var/www/html/vendor
COPY --chown=www-data:www-data api /var/www/html/api
COPY --from=version --chown=www-data:www-data /version.json /var/www/html/version.json
COPY bot/apache.conf /etc/apache2/conf-enabled/zz-bot.conf

ENV DATA_DIR=/data
VOLUME /data
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1/api/auth.php?a=me >/dev/null || exit 1
