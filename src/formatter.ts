/*eslint-disable no-shadow */

import * as Image from './image'
import * as github from '@actions/github'
import * as path from 'path'

import {
  Annotation,
  BuildLog,
  TestCodeCoverage,
  TestDetail,
  TestDetails,
  TestFailure,
  TestFailureGroup,
  TestFailures,
  TestReport,
  TestReportChapter,
  TestReportChapterDetail,
  TestReportChapterSummary,
  TestReportSection,
  actionTestSummaries,
  actionTestSummary
} from './report'
import {
  anchorIdentifier,
  anchorNameTag,
  escapeHashSign,
  indentation
} from './markdown'

import {ActionTestActivitySummary} from '../dev/@types/ActionTestActivitySummary.d'
import {ActionTestFailureSummary} from '../dev/@types/ActionTestFailureSummary.d'
import {ActionTestMetadata} from '../dev/@types/ActionTestMetadata.d'
import {ActionTestPlanRunSummaries} from '../dev/@types/ActionTestPlanRunSummaries.d'
import {ActionTestSummary} from '../dev/@types/ActionTestSummary.d'
import {ActionTestSummaryGroup} from '../dev/@types/ActionTestSummaryGroup.d'
import {ActionTestableSummary} from '../dev/@types/ActionTestableSummary.d'
import {ActionsInvocationMetadata} from '../dev/@types/ActionsInvocationMetadata.d'
import {ActionsInvocationRecord} from '../dev/@types/ActionsInvocationRecord.d'

import {Activity} from './activity'
import {ActivityLogSection} from '../dev/@types/ActivityLogSection.d'
import {Convert} from './coverage'
import {Parser} from './parser'
import {exportAttachments} from './attachment'

const passedIcon = Image.testStatus('Success')
const failedIcon = Image.testStatus('Failure')
const skippedIcon = Image.testStatus('Skipped')
const expectedFailureIcon = Image.testStatus('Expected Failure')

const backIcon = Image.icon('back.png')
const testClassIcon = Image.icon('test-class.png')
const testMethodIcon = Image.icon('test-method.png')
const attachmentIcon = Image.icon('attachment.png')

export class Formatter {
  readonly summaries = ''
  readonly details = ''

  private bundlePath: string
  private parser: Parser

  constructor(bundlePath: string) {
    this.bundlePath = bundlePath
    this.parser = new Parser(this.bundlePath)
  }

  async format(
    options: FormatterOptions = new FormatterOptions()
  ): Promise<TestReport> {
    const actionsInvocationRecord: ActionsInvocationRecord =
      await this.parser.parse()

    const testReport = new TestReport()

    if (actionsInvocationRecord.metadataRef) {
      const metadata: ActionsInvocationMetadata = await this.parser.parse(
        actionsInvocationRecord.metadataRef.id
      )

      testReport.entityName = metadata.schemeIdentifier?.entityName
      testReport.creatingWorkspaceFilePath = metadata.creatingWorkspaceFilePath
    }

    if (actionsInvocationRecord.actions) {
      for (const action of actionsInvocationRecord.actions) {
        if (action.buildResult.logRef) {
          const log: ActivityLogSection = await this.parser.parse(
            action.buildResult.logRef.id
          )
          const buildLog = new BuildLog(
            log,
            testReport.creatingWorkspaceFilePath
          )
          if (buildLog.content.length) {
            testReport.buildLog = buildLog
            testReport.testStatus = 'failure'
            for (const annotation of buildLog.annotations) {
              testReport.annotations.push(annotation)
            }
          }
        }
        if (action.actionResult) {
          if (action.actionResult.testsRef) {
            const testReportChapter = new TestReportChapter(
              action.schemeCommandName,
              action.runDestination,
              action.title
            )
            testReport.chapters.push(testReportChapter)

            const actionTestPlanRunSummaries: ActionTestPlanRunSummaries =
              await this.parser.parse(action.actionResult.testsRef.id)

            for (const summary of actionTestPlanRunSummaries.summaries) {
              for (const testableSummary of summary.testableSummaries) {
                const testSummaries: actionTestSummaries = []
                await this.collectTestSummaries(
                  testableSummary,
                  testableSummary.tests,
                  testSummaries
                )
                if (testableSummary.name) {
                  testReportChapter.sections[testableSummary.name] =
                    new TestReportSection(testableSummary, testSummaries)
                }
              }
            }

            if (action.actionResult.coverage) {
              try {
                const codeCoverage = Convert.toCodeCoverage(
                  await this.parser.exportCodeCoverage()
                )

                const testCodeCoverage = new TestCodeCoverage(codeCoverage)
                testReport.codeCoverage = testCodeCoverage
              } catch (error) {
                // no-op
              }
            }
          }
        }
      }
    }

    class TestSummaryStats {
      passed = 0
      failed = 0
      skipped = 0
      expectedFailure = 0
      total = 0
    }
    type TestSummaryStatsGroup = {[key: string]: TestSummaryStats}
    const testSummary = {
      stats: new TestSummaryStats(),
      duration: 0,
      groups: {} as {[key: string]: TestSummaryStatsGroup}
    }

    for (const chapter of testReport.chapters) {
      const chapterSummary = new TestReportChapterSummary()
      chapter.summaries.push(chapterSummary)

      for (const [identifier, results] of Object.entries(chapter.sections)) {
        const detailGroup = results.details.reduce(
          (groups: {[key: string]: actionTestSummaries}, detail) => {
            const d = detail as actionTestSummary & {group?: string}
            if (d.group) {
              if (groups[d.group]) {
                groups[d.group].push(detail)
              } else {
                groups[d.group] = [detail]
              }
            }
            return groups
          },
          {}
        )

        const group: TestSummaryStatsGroup = {}
        for (const [identifier, details] of Object.entries(detailGroup)) {
          const [stats, duration] = details.reduce(
            ([stats, duration]: [TestSummaryStats, number], detail) => {
              const test = detail as ActionTestSummary
              if (test.testStatus) {
                switch (test.testStatus) {
                  case 'Success':
                    stats.passed++
                    break
                  case 'Failure':
                    stats.failed++
                    break
                  case 'Skipped':
                    stats.skipped++
                    break
                  case 'Expected Failure':
                    stats.expectedFailure++
                    break
                }

                stats.total++
              }

              if (test.duration) {
                duration = test.duration
              }
              return [stats, duration]
            },
            [new TestSummaryStats(), 0]
          )
          testSummary.stats.passed += stats.passed
          testSummary.stats.failed += stats.failed
          testSummary.stats.skipped += stats.skipped
          testSummary.stats.expectedFailure += stats.expectedFailure
          testSummary.stats.total += stats.total
          testSummary.duration += duration

          group[identifier] = {
            passed: stats.passed,
            failed: stats.failed,
            skipped: stats.skipped,
            expectedFailure: stats.expectedFailure,
            total: stats.total
          }
        }

        const groups = testSummary.groups
        groups[identifier] = group
      }

      chapterSummary.content.push('### Summary')

      chapterSummary.content.push('<table>')
      chapterSummary.content.push('<tr>')
      const header = [
        `<th>Total`,
        `<th>${passedIcon}&nbsp;Passed`,
        `<th>${failedIcon}&nbsp;Failed`,
        `<th>${skippedIcon}&nbsp;Skipped`,
        `<th>${expectedFailureIcon}&nbsp;Expected Failure`,
        `<th>:stopwatch:&nbsp;Time`
      ].join('')
      chapterSummary.content.push(header)

      chapterSummary.content.push('<tr>')

      let failedCount: string
      if (testSummary.stats.failed > 0) {
        failedCount = `<b>${testSummary.stats.failed}</b>`
      } else {
        failedCount = `${testSummary.stats.failed}`
      }
      const duration = testSummary.duration.toFixed(2)
      const cols = [
        `<td align="right" width="118px">${testSummary.stats.total}`,
        `<td align="right" width="118px">${testSummary.stats.passed}`,
        `<td align="right" width="118px">${failedCount}`,
        `<td align="right" width="118px">${testSummary.stats.skipped}`,
        `<td align="right" width="158px">${testSummary.stats.expectedFailure}`,
        `<td align="right" width="138px">${duration}s`
      ].join('')
      chapterSummary.content.push(cols)
      chapterSummary.content.push('</table>\n')

      chapterSummary.content.push('---\n')

      if (testSummary.stats.failed > 0) {
        testReport.testStatus = 'failure'
      } else if (testSummary.stats.passed > 0) {
        testReport.testStatus = 'success'
      }

      chapterSummary.content.push('---\n')
    }
    return testReport
  }

  async collectTestSummaries(
    group: ActionTestableSummary | ActionTestSummaryGroup,
    tests: actionTestSummaries,
    testSummaries: actionTestSummaries
  ): Promise<void> {
    for (const test of tests) {
      if (test.hasOwnProperty('subtests')) {
        const group = test as ActionTestSummaryGroup
        await this.collectTestSummaries(group, group.subtests, testSummaries)
      } else {
        const t = test as actionTestSummary & {group?: string}
        t.group = group.name
        testSummaries.push(test)
      }
    }
  }

  async collectActivities(
    activitySummaries: ActionTestActivitySummary[],
    activities: Activity[],
    indent = 0
  ): Promise<void> {
    for (const activitySummary of activitySummaries) {
      const activity = activitySummary as Activity
      activity.indent = indent
      await exportAttachments(this.parser, activity)
      activities.push(activity)

      if (activitySummary.subactivities) {
        await this.collectActivities(
          activitySummary.subactivities,
          activities,
          indent + 1
        )
      }
    }
  }
}

function collectFailureSummaries(
  failureSummaries: ActionTestFailureSummary[]
): FailureSummary[] {
  return failureSummaries.map(failureSummary => {
    const fileName = failureSummary.fileName
    const sourceCodeContext = failureSummary.sourceCodeContext
    const callStack = sourceCodeContext?.callStack
    const location = sourceCodeContext?.location
    const filePath = location?.filePath || fileName
    const lineNumber = location?.lineNumber

    let fileLocation = ''
    if (fileName && lineNumber) {
      fileLocation = `${fileName}:${lineNumber}`
    } else if (fileName) {
      fileLocation = fileName
    }

    const titleAlign = 'align="right"'
    const titleWidth = 'width="100px"'
    const titleAttr = `${titleAlign} ${titleWidth}`
    const detailWidth = 'width="668px"'
    const contents =
      '<table>' +
      `<tr><td ${titleAttr}><b>File</b><td ${detailWidth}>${fileLocation}` +
      `<tr><td ${titleAttr}><b>Issue Type</b><td ${detailWidth}>${failureSummary.issueType}` +
      `<tr><td ${titleAttr}><b>Message</b><td ${detailWidth}>${failureSummary.message}` +
      `</table>\n`

    const stackTrace = callStack
      ?.map((callStack, index) => {
        const addressString = callStack.addressString
        const symbolInfo = callStack.symbolInfo
        const imageName = symbolInfo?.imageName || ''
        const symbolName = symbolInfo?.symbolName || ''
        const location = symbolInfo?.location
        const filePath = location?.filePath || fileName
        const lineNumber = location?.lineNumber
        const seq = `${index}`.padEnd(2, ' ')
        return `${seq} ${imageName} ${addressString} ${symbolName} ${filePath}: ${lineNumber}`
      })
      .join('\n')
    return {
      filePath,
      lineNumber,
      issueType: failureSummary.issueType,
      message: failureSummary.message,
      contents,
      stackTrace: stackTrace || []
    } as FailureSummary
  })
}

interface FailureSummary {
  filePath: string
  lineNumber: number
  issueType: string
  message: string
  contents: string
  stackTrace: string
}

export class FormatterOptions {
  showPassedTests: boolean
  showCodeCoverage: boolean

  constructor(showPassedTests = true, showCodeCoverage = true) {
    this.showPassedTests = showPassedTests
    this.showCodeCoverage = showCodeCoverage
  }
}
