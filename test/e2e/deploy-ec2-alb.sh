set -euf -o pipefail

# need to run in dev so it can access the dev.restate.cloud hosted zone
npx cdk --app 'npx tsx single-node-ec2-alb.e2e.ts' \
    --profile restate-cloud-dev-admin \
    deploy \
    --output cdk.ec2-alb.out \
    --context vpc_id=vpc-058ff0dc027b2df5a \
    --context domainName=dev.restate.cloud \
    --context hostname=single-node-ec2 #\
#    --require-approval never \
#    --no-rollback
