{{- define "auction.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Если имя релиза уже содержит имя чарта, не удваиваем его: auction-api, а не auction-auction-api. */}}
{{- define "auction.fullname" -}}
{{- $name := include "auction.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "auction.labels" -}}
app.kubernetes.io/name: {{ include "auction.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Образ приложения. Тег по умолчанию — appVersion чарта, чтобы выкат был воспроизводим. */}}
{{- define "auction.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/%s-%s:%s" .Values.image.registry .Values.image.repository .component $tag -}}
{{- end -}}

{{/*
Секреты подключаются целиком через envFrom: перечислять их по одному значит
рано или поздно забыть новый ключ и уронить прод на старте.
*/}}
{{- define "auction.secretEnv" -}}
- secretRef:
    name: {{ .Values.secrets.existingSecret | quote }}
{{- end -}}
