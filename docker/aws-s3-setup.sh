#!/bin/bash
# Creates the file storage for Tally in AWS S3 (PLAN section 12, D42, D58, D60). Paste into AWS
# CloudShell (Frankfurt, eu-central-1), with the bucket name and the site's address:
#   bash aws-s3-setup.sh eu-central-1 <bucket> https://tally.<agency domain>
# The bucket name must be lowercase and have no dots. Safe to run again: it only creates what is
# missing and sets the rest again. The first run prints an access key ONCE: paste it into the
# server with set-secrets.sh and into the password manager, nowhere else.
set -euo pipefail
region=${1:?region}
bucket=${2:?bucket name}
site=${3:?the site address, https://...}

case $site in
  */) echo "Give the address without a / at the end: ${site%/}"; exit 1 ;;
  https://*) ;;
  *) echo "The address must start with https://"; exit 1 ;;
esac

if aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
  echo "The bucket $bucket exists; setting it up again."
else
  aws s3api create-bucket --bucket "$bucket" --region "$region" \
    --create-bucket-configuration "LocationConstraint=$region"
fi
aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$bucket" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
# Deleted files are really gone a day later (6.4); unconfirmed uploads after 2 days (D42).
aws s3api put-bucket-lifecycle-configuration --bucket "$bucket" --lifecycle-configuration '{"Rules":[
  {"ID":"old-versions","Status":"Enabled","Filter":{},
   "NoncurrentVersionExpiration":{"NoncurrentDays":1},
   "Expiration":{"ExpiredObjectDeleteMarker":true},
   "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}},
  {"ID":"unconfirmed-uploads","Status":"Enabled","Filter":{"Prefix":"uploads/"},
   "Expiration":{"Days":2}}]}'
# The browser uploads straight to storage from the site, and only from it.
aws s3api put-bucket-cors --bucket "$bucket" --cors-configuration "{\"CORSRules\":[
  {\"AllowedOrigins\":[\"$site\"],\"AllowedMethods\":[\"PUT\"],\"AllowedHeaders\":[\"content-type\"],\"MaxAgeSeconds\":3000}]}"
aws s3api put-bucket-policy --bucket "$bucket" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[
  {\"Sid\":\"HttpsOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",
   \"Resource\":[\"arn:aws:s3:::$bucket\",\"arn:aws:s3:::$bucket/*\"],
   \"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"

# The app's own key: read, write and delete files in this bucket, nothing else.
new_user=false
if ! aws iam get-user --user-name tally-app >/dev/null 2>&1; then
  aws iam create-user --user-name tally-app
  new_user=true
fi
aws iam put-user-policy --user-name tally-app --policy-name tally-bucket --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::$bucket/*\"},
  {\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::$bucket\"}]}"
if $new_user; then
  echo "The app's access key (shown once; save it in the password manager, then set-secrets.sh):"
  aws iam create-access-key --user-name tally-app \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text
else
  echo "The user tally-app already exists with its key (in the password manager); no new key made."
fi
