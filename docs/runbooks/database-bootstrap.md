# Runbook: Database bootstrap (one-time per instance, manual)

Two things have to happen on a fresh Compass database that Terraform cannot do,
because both need an authenticated PostgreSQL session as the master user:

1. `CREATE EXTENSION vector` — installing an extension needs `rds_superuser`.
2. `GRANT rds_iam TO compass_app` — the role that IAM authentication maps onto
   has to exist before anything can authenticate as it.

The second is the interesting one. **IAM authentication cannot bootstrap
itself**: the database role does not exist until this grant runs, so there is no
principal for IAM to authorise, so this is the one place a password is
unavoidable. That password is generated and held by RDS in Secrets Manager, is
used here and nowhere else, and never reaches the application.

Everything below is idempotent. Run it twice and nothing breaks — you will
rebuild this instance at least once, and COMPASS-14's migrations assume the same
property.

## Prerequisites

- `terraform apply` has completed in `infra/terraform/envs/dev`.
- The `/compass/dev/db/*` parameters exist in SSM Parameter Store.
- **`session-manager-plugin` installed locally** — `brew install --cask session-manager-plugin`.
  Without it `aws ssm start-session` fails. `aws ssm send-command` does not need
  it, which is why COMPASS-5 never surfaced this.

No local `psql` is required. Everything runs on the jump host.

## 1. Temporary jump host

The database is in a private subnet with no public address, so nothing on a
laptop can reach it. Create a throwaway instance, and delete it at the end of
this runbook — the same discipline as the COMPASS-5 reachability proof. It lives
in no Terraform state on purpose: a one-off verification host has no business
being a permanent, planned resource.

```bash
export AWS_DEFAULT_REGION=eu-west-1
ENV=dev

APP_SG=$(aws ssm get-parameter --name "/compass/$ENV/db/app_security_group_id" --query Parameter.Value --output text)
SUBNET=$(aws ec2 describe-subnets --filters "Name=tag:Name,Values=compass-$ENV-private-*" \
  --query 'Subnets[0].SubnetId' --output text)
AMI=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text)
echo "APP_SG=$APP_SG SUBNET=$SUBNET AMI=$AMI"   # all three must be non-empty
```

The role below is deliberately over-permissioned relative to the workload: a
human at a prompt needs to *find* things, so it can read parameters and describe
the instance. **The ingestion Lambda (COMPASS-11) needs only `rds-db:connect`.**
Do not use this role as the template for the real one.

```bash
aws iam create-role --role-name compass-tmp-bootstrap \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name compass-tmp-bootstrap \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

SECRET_ARN=$(aws rds describe-db-instances --db-instance-identifier "compass-$ENV" \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
aws iam put-role-policy --role-name compass-tmp-bootstrap --policy-name read-master-secret \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"}]}"
aws iam put-role-policy --role-name compass-tmp-bootstrap --policy-name describe-db \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"rds:DescribeDBInstances","Resource":"*"}]}'
aws iam put-role-policy --role-name compass-tmp-bootstrap --policy-name read-compass-params \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ssm:GetParameter","ssm:GetParameters"],"Resource":"arn:aws:ssm:eu-west-1:*:parameter/compass/*"}]}'

# The policy under test. Same one the ingestion Lambda gets at COMPASS-11 and
# the IRSA role gets at COMPASS-6; only the trust policy differs.
aws iam attach-role-policy --role-name compass-tmp-bootstrap \
  --policy-arn "$(aws ssm get-parameter --name "/compass/$ENV/db/connect_policy_arn" --query Parameter.Value --output text)"

aws iam create-instance-profile --instance-profile-name compass-tmp-bootstrap
aws iam add-role-to-instance-profile --instance-profile-name compass-tmp-bootstrap \
  --role-name compass-tmp-bootstrap
```

```bash
# Attaching the app security group is how this host is permitted through to
# 5432, and is itself a test that the rule works.
INSTANCE=$(aws ec2 run-instances \
  --image-id "$AMI" --instance-type t3.micro \
  --subnet-id "$SUBNET" --security-group-ids "$APP_SG" \
  --iam-instance-profile Name=compass-tmp-bootstrap \
  --metadata-options 'HttpTokens=required' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=compass-tmp-bootstrap},{Key=Project,Value=compass}]' \
  --query 'Instances[0].InstanceId' --output text)
echo "INSTANCE=$INSTANCE"

aws ec2 wait instance-status-ok --instance-ids "$INSTANCE"
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text
```

No key pair and no SSH: access is Session Manager only, reaching AWS outbound
through the NAT instance from ADR-0001. `PingStatus: Online` is itself a third
proof of that egress path.

Install the client and the CA bundle on the host:

```bash
aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters 'commands=["dnf install -y postgresql17 jq","curl -sS -o /usr/local/share/rds-ca.pem https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem","psql --version"]'
```

## 2. Connect as master

```bash
aws ssm start-session --target "$INSTANCE" --region eu-west-1
```

Then, on the host:

```bash
export AWS_DEFAULT_REGION=eu-west-1
DB_HOST=$(aws ssm get-parameter --name /compass/dev/db/endpoint --query Parameter.Value --output text)
SECRET_ARN=$(aws rds describe-db-instances --db-instance-identifier compass-dev \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
export PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" \
  --query SecretString --output text | jq -r .password)

# Check before connecting. An empty variable here produces a misleading error:
# psql silently falls back to a local unix socket, or prompts for a password.
echo "host=[$DB_HOST] pass=[${#PGPASSWORD} chars]"

psql "host=$DB_HOST port=5432 dbname=compass user=compass_admin \
      sslmode=verify-full sslrootcert=/usr/local/share/rds-ca.pem"
```

Never drop to `sslmode=require` to get past a certificate problem. It skips
verification entirely, and on a bearer-token scheme that is the whole game:
anything able to intercept the connection gets a token it can replay for fifteen
minutes.

## 3. Bootstrap SQL

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- CREATE ROLE has no IF NOT EXISTS, hence the guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'compass_app') THEN
    CREATE ROLE compass_app WITH LOGIN;
  END IF;
END
$$;

-- The grant that makes IAM authentication work. rds_iam is RDS-provided; a
-- member of it can *only* authenticate by token, never by password, even if
-- one were set.
GRANT rds_iam TO compass_app;

GRANT CONNECT ON DATABASE compass TO compass_app;
GRANT USAGE ON SCHEMA public TO compass_app;

-- The role migrations run as (COMPASS-14). Separate from both the master user
-- and the application: it needs DDL, the application must never have DDL, and
-- neither should depend on a password. rds_iam makes token auth the only way
-- in, so the master password stays used exactly once -- here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'compass_migrator') THEN
    CREATE ROLE compass_migrator WITH LOGIN;
  END IF;
END
$$;

GRANT rds_iam TO compass_migrator;
GRANT CONNECT ON DATABASE compass TO compass_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO compass_migrator;

-- Setting default privileges FOR ROLE x requires membership of x, so the master
-- user has to be a member of the migration role before the grant below. This is
-- administration, not a privilege escalation: compass_admin already outranks it.
GRANT compass_migrator TO compass_admin;

-- Tables created by the migration role are owned by it, so the application's
-- grants are issued by the migration itself rather than inherited from here.
-- This covers the sequences and anything the master user creates directly.
ALTER DEFAULT PRIVILEGES FOR ROLE compass_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO compass_app;
ALTER DEFAULT PRIVILEGES FOR ROLE compass_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO compass_app;
ALTER DEFAULT PRIVILEGES FOR ROLE compass_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO compass_app;
```

`compass_migrator` needs an IAM policy allowing `rds-db:connect` for that
database user, the same shape as the application's. The Terraform `rds` module
emits one per user — check `connect_policy_arn` covers `compass_migrator`
before assuming the token will be accepted.

Verify, then `\q`:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';

-- Both aliases expose rolname, so it has to be qualified.
SELECT r.rolname AS member, g.rolname AS granted
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.member
JOIN pg_roles g ON g.oid = m.roleid
WHERE g.rolname = 'rds_iam';
```

Expected: a pgvector version, and two rows — `compass_app | rds_iam` and
`compass_migrator | rds_iam`.

## 4. Prove IAM authentication (the acceptance criterion)

Still on the jump host, which holds no database password. `generate-db-auth-token`
makes **no network call** — it is a SigV4 signature computed locally over the
hostname, port and username, which is why it works from a private subnet with no
route to the RDS API. The credential doing the signing is the instance profile.

```bash
unset PGPASSWORD
export PGPASSWORD=$(aws rds generate-db-auth-token \
  --hostname "$DB_HOST" --port 5432 --username compass_app --region eu-west-1)

psql "host=$DB_HOST port=5432 dbname=compass user=compass_app \
      sslmode=verify-full sslrootcert=/usr/local/share/rds-ca.pem" \
  -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

A pgvector version here means the criterion is met: same database, same query, no
password anywhere in the path.

### If it fails with `PAM authentication failed`

That is IAM refusing, not PostgreSQL. The connection reached the server and TLS
verified — only authorisation failed. Check, in order: the `rds-db:connect`
policy is attached to the calling role; the policy's resource ARN carries the
instance's current **resource id** (`aws rds describe-db-instances … DbiResourceId`,
a `db-XXXX` value, not the identifier); and `compass_app` is an `rds_iam` member.

**Then wait a few minutes and retry unchanged.** RDS caches IAM authentication
decisions, denials included, so a correct fix keeps failing for a short window
afterwards. This bit us during COMPASS-13: two identical failures, no change made,
then success. The trap is that anything you happen to alter during that window
looks like the fix.

## 5. Destroy the jump host

Not optional, and in the same session.

```bash
aws ec2 terminate-instances --instance-ids "$INSTANCE"
aws ec2 wait instance-terminated --instance-ids "$INSTANCE"

aws iam remove-role-from-instance-profile \
  --instance-profile-name compass-tmp-bootstrap --role-name compass-tmp-bootstrap
aws iam delete-instance-profile --instance-profile-name compass-tmp-bootstrap
for pol in read-master-secret describe-db read-compass-params; do
  aws iam delete-role-policy --role-name compass-tmp-bootstrap --policy-name "$pol"
done
aws iam detach-role-policy --role-name compass-tmp-bootstrap \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam detach-role-policy --role-name compass-tmp-bootstrap \
  --policy-arn "$(aws ssm get-parameter --name /compass/dev/db/connect_policy_arn --query Parameter.Value --output text)"
aws iam delete-role --role-name compass-tmp-bootstrap
```

Confirm nothing is left. The first should be empty; the second should list only
`compass-dev-nat`; the third should say `No changes`.

```bash
aws ec2 describe-instances --filters "Name=tag:Name,Values=compass-tmp-bootstrap" \
  "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text
aws ec2 describe-instances --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].Tags[?Key==`Name`].Value|[]' --output text
(cd infra/terraform/envs/dev && terraform plan)
```
