// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Code, Function as LambdaFunction, Runtime } from '@aws-cdk/aws-lambda';
import { Aws, CfnResource, Construct, Duration, RemovalPolicy, Stack, Tags } from '@aws-cdk/core';
import { IBucket } from '@aws-cdk/aws-s3';
import { LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import { Effect, Policy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import {
    AccessLogFormat,
    AuthorizationType,
    CfnAccount,
    ContentHandling,
    Deployment,
    EndpointType,
    Integration,
    IntegrationType,
    LogGroupLogDestination,
    MethodLoggingLevel,
    MethodOptions,
    PassthroughBehavior,
    RequestValidator,
    RestApi,
    Stage
} from '@aws-cdk/aws-apigateway';


/**
 * @interface DLTAPIProps
 * DLTAPI props
*/
export interface DLTAPIProps {
    // ECS CloudWatch Log Group
    readonly ecsCloudWatchLogGroup: LogGroup;
    // CloudWatch Logs Policy
    readonly cloudWatchLogsPolicy: Policy;
    // DynamoDB policy
    readonly dynamoDbPolicy: Policy,
    //Task Canceler Invoke Policy
    readonly taskCancelerInvokePolicy: Policy;
    // Test scenarios S3 bucket
    readonly scenariosBucketName: string;
    // Test scenarios S3 bucket policy
    readonly scenariosS3Policy: Policy;
    // Test scenarios DynamoDB table
    readonly scenariosTableName: string;
    // ECS cluster
    readonly ecsCuster: string;
    // ECS Task Execution Role ARN
    readonly ecsTaskExecutionRoleArn: string;
    // Task Runner state function
    readonly taskRunnerStepFunctionsArn: string;
    // Task canceler ARN
    readonly tastCancelerArn: string;
    /**
    * Solution config properties.
    * the metric URL endpoint, send anonymous usage, solution ID, version, source code bucket, and source code prefix
    */
    readonly metricsUrl: string;
    readonly sendAnonymousUsage: string;
    readonly solutionId: string;
    readonly solutionVersion: string;
    readonly sourceCodeBucket: IBucket;
    readonly sourceCodePrefix: string;
    // UUID
    readonly uuid: string;
}

/**
 * @class
 * Distributed Load Testing on AWS API construct
 */
export class DLTAPI extends Construct {
    apiId: string;
    apiEndpointPath: string;

    constructor(scope: Construct, id: string, props: DLTAPIProps) {
        super(scope, id);

        const taskArn = Stack.of(this).formatArn({ service: 'ecs', resource: 'task', sep: '/', resourceName: '*' });
        const taskDefArn = Stack.of(this).formatArn({ service: 'ecs', resource: 'task-definition/' });

        const dltApiServicesLambdaRole = new Role(this, 'DLTAPIServicesLambdaRole', {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            inlinePolicies: {
                'DLTAPIServicesLambdaPolicy': new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: ['ecs:ListTasks'],
                            resources: ['*']
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'ecs:RunTask',
                                'ecs:DescribeTasks'
                            ],
                            resources: [
                                taskArn,
                                taskDefArn
                            ]
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: ['iam:PassRole'],
                            resources: [props.ecsTaskExecutionRoleArn]
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: ['states:StartExecution'],
                            resources: [props.taskRunnerStepFunctionsArn]
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: ['logs:DeleteMetricFilter'],
                            resources: [props.ecsCloudWatchLogGroup.logGroupArn]
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: ['cloudwatch:DeleteDashboards'],
                            resources: [`arn:${Aws.PARTITION}:cloudwatch::${Aws.ACCOUNT_ID}:dashboard/EcsLoadTesting*`]
                        })
                    ]
                })
            }
        });
        dltApiServicesLambdaRole.attachInlinePolicy(props.cloudWatchLogsPolicy);
        dltApiServicesLambdaRole.attachInlinePolicy(props.dynamoDbPolicy);
        dltApiServicesLambdaRole.attachInlinePolicy(props.scenariosS3Policy);
        dltApiServicesLambdaRole.attachInlinePolicy(props.taskCancelerInvokePolicy);

        const ruleSchedArn = Stack.of(this).formatArn({ service: 'events', resource: 'rule', resourceName: '*Scheduled' });
        const ruleCreateArn = Stack.of(this).formatArn({ service: 'events', resource: 'rule', resourceName: '*Create' });
        const ruleListArn = Stack.of(this).formatArn({ service: 'events', resource: 'rule', resourceName: '*' });

        const lambdaApiEventsPolicy = new Policy(this, 'LambdaApiEventsPolicy', {
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'events:PutTargets',
                        'events:PutRule',
                        'events:DeleteRule',
                        'events:RemoveTargets'
                    ],
                    resources: [
                        ruleSchedArn,
                        ruleCreateArn
                    ]
                }),
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'events:ListRules'
                    ],
                    resources: [
                        ruleListArn
                    ]
                })
            ]
        });
        dltApiServicesLambdaRole.attachInlinePolicy(lambdaApiEventsPolicy);

        const apiLambdaRoleResource = dltApiServicesLambdaRole.node.defaultChild as CfnResource;
        apiLambdaRoleResource.addMetadata('cfn_nag', {
            rules_to_suppress: [{
                id: 'W11',
                reason: 'ecs:ListTasks does not support resource level permissions'
            }]
        });

        const dltApiServicesLambda = new LambdaFunction(this, 'DLTAPIServicesLambda', {
            description: 'API microservices for creating, updating, listing and deleting test scenarios',
            code: Code.fromBucket(props.sourceCodeBucket, `${props.sourceCodePrefix}/api-services.zip`),
            runtime: Runtime.NODEJS_14_X,
            handler: 'index.handler',
            timeout: Duration.seconds(120),
            environment: {
                SCENARIOS_BUCKET: props.scenariosBucketName,
                SCENARIOS_TABLE: props.scenariosTableName,
                TASK_CLUSTER: props.ecsCuster,
                STATE_MACHINE_ARN: props.taskRunnerStepFunctionsArn,
                SOLUTION_ID: props.solutionId,
                UUID: props.uuid,
                VERSION: props.solutionVersion,
                SEND_METRIC: props.sendAnonymousUsage,
                METRIC_URL: props.metricsUrl,
                ECS_LOG_GROUP: props.ecsCloudWatchLogGroup.logGroupName,
                TASK_CANCELER_ARN: props.tastCancelerArn
            },
            role: dltApiServicesLambdaRole
        });
        Tags.of(dltApiServicesLambda).add('SolutionId', props.solutionId);
        const apiLambdaResource = dltApiServicesLambda.node.defaultChild as CfnResource;
        apiLambdaResource.addMetadata('cfn_nag', {
            rules_to_suppress: [{
                id: 'W58',
                reason: 'CloudWatchLogsPolicy covers a permission to write CloudWatch logs.'
            }, {
                id: 'W89',
                reason: 'VPC not needed for lambda'
            }, {
                id: 'W92',
                reason: 'Does not run concurrent executions'
            }]
        });

        const lambdaApiPermissionPolicy = new Policy(this, 'LambdaApiPermissionPolicy', {
            statements: [
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                        'lambda:AddPermission',
                        'lambda:RemovePermission'
                    ],
                    resources: [dltApiServicesLambda.functionArn]
                })
            ]
        });
        dltApiServicesLambdaRole.attachInlinePolicy(lambdaApiPermissionPolicy);

        const apiLogs = new LogGroup(this, 'APILogs', {
            retention: RetentionDays.ONE_YEAR,
            removalPolicy: RemovalPolicy.RETAIN
        });
        const apiLogsResource = apiLogs.node.defaultChild as CfnResource;
        apiLogsResource.addMetadata('cfn_nag', {
            rules_to_suppress: [{
                id: 'W84',
                reason: 'KMS encryption unnecessary for log group'
            }]
        });

        const logsArn = Stack.of(this).formatArn({ service: 'logs', resource: '*' })
        const apiLoggingRole = new Role(this, 'APILoggingRole', {
            assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
            inlinePolicies: {
                'apiLoggingPolicy': new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'logs:CreateLogGroup',
                                'logs:CreateLogStream',
                                'logs:DescribeLogGroups',
                                'logs:DescribeLogStreams',
                                'logs:PutLogEvents',
                                'logs:GetLogEvents',
                                'logs:FilterLogEvent',
                            ],
                            resources: [
                                logsArn
                            ]
                        })
                    ]
                })
            }
        });

        const api = new RestApi(this, 'DLTApi', {
            defaultCorsPreflightOptions: {
                allowOrigins: ['*'],
                allowHeaders: [
                    'Authorization',
                    'Content-Type',
                    'X-Amz-Date',
                    'X-Amz-Security-Token',
                    'X-Api-Key'
                ],
                allowMethods: [
                    'DELETE',
                    'GET',
                    'HEAD',
                    'OPTIONS',
                    'PATCH',
                    'POST',
                    'PUT'
                ],
                statusCode: 200
            },
            deploy: true,
            deployOptions: {
                accessLogDestination: new LogGroupLogDestination(apiLogs),
                accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
                loggingLevel: MethodLoggingLevel.INFO,
                stageName: 'prod',
                tracingEnabled: true
            },
            description: `Distributed Load Testing API - version ${props.solutionVersion}`,
            endpointTypes: [EndpointType.EDGE]
        });

        this.apiId = api.restApiId;
        this.apiEndpointPath = api.url.slice(0, -1);

        const apiAccountConfig = new CfnAccount(this, 'ApiAccountConfig', {
            cloudWatchRoleArn: apiLoggingRole.roleArn
        });
        apiAccountConfig.addDependsOn(api.node.defaultChild as CfnResource);

        const apiAllRequestValidator = new RequestValidator(this, 'APIAllRequestValidator', {
            restApi: api,
            validateRequestBody: true,
            validateRequestParameters: true
        });

        const apiDeployment = api.node.findChild('Deployment') as Deployment;
        const apiDeploymentResource = apiDeployment.node.defaultChild as CfnResource;
        apiDeploymentResource.addMetadata('cfn_nag', {
            rules_to_suppress: [{
                id: 'W68',
                reason: 'The solution does not require the usage plan.'
            }]
        });

        const apiFindProdResource = api.node.findChild('DeploymentStage.prod') as Stage;
        const apiProdResource = apiFindProdResource.node.defaultChild as CfnResource;
        apiProdResource.addMetadata('cfn_nag', {
            rules_to_suppress: [{
                id: 'W64',
                reason: 'The solution does not require the usage plan.'
            }]
        });

        const allIntegration = new Integration({
            type: IntegrationType.AWS_PROXY,
            integrationHttpMethod: 'POST',
            options: {
                contentHandling: ContentHandling.CONVERT_TO_TEXT,
                integrationResponses: [{ statusCode: '200' }],
                passthroughBehavior: PassthroughBehavior.WHEN_NO_MATCH,
            },
            uri: `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}:lambda:path/2015-03-31/functions/${dltApiServicesLambda.functionArn}/invocations`
        });
        const allMethodOptions: MethodOptions = {
            authorizationType: AuthorizationType.IAM,
            methodResponses: [{
                statusCode: '200',
                responseModels: {
                    'application/json': { modelId: 'Empty' }
                }
            }],
            requestValidator: apiAllRequestValidator
        };

        /** Test scenario API
         * /scenarios
         * /scenarios/{testId}
         * /tasks
         */
        const scenariosResource = api.root.addResource('scenarios');
        scenariosResource.addMethod('ANY', allIntegration, allMethodOptions);

        const testIds = scenariosResource.addResource('{testId}');
        testIds.addMethod('ANY', allIntegration, allMethodOptions);

        const tasksResource = api.root.addResource('tasks');
        tasksResource.addMethod('ANY', allIntegration, allMethodOptions);


        const invokeSourceArn = Stack.of(this).formatArn({ service: 'execute-api', resource: api.restApiId, resourceName: '*' });
        dltApiServicesLambda.addPermission('DLTApiInvokePermission', {
            action: 'lambda:InvokeFunction',
            principal: new ServicePrincipal('apigateway.amazonaws.com'),
            sourceArn: invokeSourceArn
        });

    }
}