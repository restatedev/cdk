set -euf -o pipefail

npx cdk --app 'npx tsx single-node-ec2.e2e.ts' \
    --profile restate-eng \
    deploy \
    --require-approval never
#    --no-rollback
#    --context vpc_id=vpc-0d2e373fed47934f3 \ # VPC in mgmt account 663487780041 with egress gw
